import express from 'express';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { GameEngine } from './engine.js';
import { createAIHost, questionSchema, solutionSchema } from './host.js';
import { catalog } from './cases.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const actions = ['say', 'start', 'hint', 'repeat', 'solve', 'reveal', 'status', 'list'];
const turnSchema = z.object({ action: z.enum(actions).default('say'), text: z.string().max(1200).default(''), caseId: z.string().max(80).optional(), confirm: z.boolean().default(false) }).strict();
const commitSchema = z.object({ requestId: z.string().uuid(), judgment: z.discriminatedUnion('kind', [
  questionSchema.extend({ kind: z.literal('ask') }), solutionSchema.extend({ kind: z.literal('judge') })
]) }).strict();
const idSchema = z.string().min(1).max(128).regex(/^[\w.:-]+$/);
const identity = (device, agent, session) => {
  if (!idSchema.safeParse(device).success || !idSchema.safeParse(session).success || (agent && !idSchema.safeParse(agent).success)) throw new Error('缺少或无效的设备 / 会话标识');
  return `linx:${createHash('sha256').update(JSON.stringify([device, agent || '', session])).digest('hex')}`;
};
const equal = (a, b) => {
  const aa = Buffer.from(a || ''), bb = Buffer.from(b || '');
  return aa.length === bb.length && timingSafeEqual(aa, bb);
};

export function createApp({ dbPath = process.env.DB_PATH || resolve(root, 'data/games.sqlite'), token = process.env.LINX_SERVICE_TOKEN, semantic = null, host = process.env.AI_HOST_ENABLED === '1' ? createAIHost({ url: process.env.LLM_BASE_URL, key: process.env.LLM_API_KEY, model: process.env.LLM_MODEL, reasoningEffort: process.env.LLM_REASONING_EFFORT || undefined }) : null, publicOrigin = process.env.PUBLIC_ORIGIN, agentHostEnabled = process.env.LINX_AGENT_HOST_ENABLED === '1', diagnostics = process.env.MCP_DIAGNOSTICS === '1', diagnosticLog = entry => console.info('[mcp]', JSON.stringify(entry)) } = {}) {
  const app = express();
  if (process.env.AI_HOST_ENABLED === '1' && !host) throw new Error('AI_HOST_ENABLED=1 时必须配置模型地址、密钥和型号');
  const engine = new GameEngine(dbPath, semantic, host);
  const activeMcpServers = new Set();
  const buckets = new Map();
  const housekeeping = setInterval(() => { const now = Date.now(); for (const [key, b] of buckets) if (b.until < now) buckets.delete(key); }, 60000).unref();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    if (diagnostics && req.path.startsWith('/mcp')) {
      const started = Date.now();
      const entry = {
        time: new Date().toISOString(), method: req.method,
        path: req.path === '/mcp' ? '/mcp' : '/mcp/*',
        hasAuthorization: Boolean(req.get('authorization')),
        authValid: Boolean(token) && equal(req.get('authorization'), `Bearer ${token}`),
        hasDevice: Boolean(req.get('x-linx-device-id')),
        hasSession: Boolean(req.get('x-linx-session-id'))
      };
      diagnosticLog({ ...entry, event: 'received' });
      res.on('close', () => {
        const methods = ['initialize', 'notifications/initialized', 'tools/list', 'tools/call', 'ping'];
        diagnosticLog({ ...entry, event: 'closed', status: res.statusCode, elapsedMs: Date.now() - started,
          rpcMethod: methods.includes(req.body?.method) ? req.body.method : null,
          toolName: ['mystery_catalog', 'mystery_turn', 'mystery_commit'].includes(req.body?.params?.name) ? req.body.params.name : null });
      });
    }
    next();
  });
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'", 'Permissions-Policy': 'microphone=(self)' });
    const origin = req.get('origin');
    const expected = publicOrigin || `${req.protocol}://${req.get('host')}`;
    if (origin && origin !== expected) return res.status(403).json({ error: '不允许跨站请求' });
    if (req.path.startsWith('/api') || req.path.startsWith('/mcp')) {
      res.set('Cache-Control', 'no-store');
      const key = req.socket.remoteAddress || 'unknown';
      let b = buckets.get(key);
      if (!b || b.until < Date.now()) { b = { count: 0, until: Date.now() + 60000 }; buckets.set(key, b); }
      if (++b.count > 240) return res.status(429).json({ error: '操作太快，请稍后再试' });
    }
    next();
  });
  app.use(express.json({ limit: '16kb' }));
  const auth = (req, res, next) => {
    if (!token) return res.status(503).json({ error: '尚未配置 LINX_SERVICE_TOKEN，平台接口未开放' });
    if (!equal(req.get('authorization'), `Bearer ${token}`)) return res.status(401).json({ error: '认证失败' });
    next();
  };
  const browser = (req, res, next) => {
    let id = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('misheng='))?.slice(8);
    if (!/^[a-f0-9]{64}$/.test(id || '')) {
      id = randomBytes(32).toString('hex');
      res.append('Set-Cookie', `misheng=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${publicOrigin?.startsWith('https:') ? '; Secure' : ''}`);
    }
    req.player = `web:${id}`;
    next();
  };
  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
  app.get('/api/catalog', (_req, res) => res.json({ cases: catalog(), semantic: Boolean(semantic || host), hostMode: host ? 'ai' : 'rules', mcpHostMode: agentHostEnabled ? 'agent' : host ? 'ai' : 'rules', voice: 'browser-preview' }));
  app.get('/api/state', browser, (req, res) => res.json({ state: engine.snapshot(engine.load(req.player)) }));
  app.post('/api/turn', browser, async (req, res) => res.json(await engine.turn(req.player, turnSchema.parse(req.body))));

  // 第三方业务模式：请求和响应 session_id 原样对应。平台负责 ASR / TTS。
  app.post('/api/chat/stream', auth, async (req, res) => {
    const body = z.object({ auth: z.object({ device_id: idSchema }), type: z.literal('chat'), details: z.object({ msg: z.string().min(1).max(1200), session_id: idSchema }) }).parse(req.body);
    const { session_id: session, msg } = body.details;
    const result = await engine.turn(identity(body.auth.device_id, '', session), { text: msg });
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
    res.write(`data: ${JSON.stringify({ event: 'message', type: 'chat', session_id: session, details: { answer: result.answer } })}\n\n`);
    res.end(`data: ${JSON.stringify({ event: 'message_end', session_id: session })}\n\n`);
  });

  // 当前灵矽控制台使用 Streamable HTTP；每个请求独立 transport，游戏状态由数据库维护。
  const createMcpServer = () => {
    const server = new McpServer({ name: 'misheng', version: '0.1.0' });
    const playerFrom = extra => {
      const headers = extra.requestInfo?.headers || {};
      return identity(headers['x-linx-device-id'], headers['x-linx-agent-id'], headers['x-linx-session-id']);
    };
    server.registerTool('mystery_catalog', { description: '列出谜声的可玩谜题，不包含谜底。', inputSchema: {} }, async () => ({ content: [{ type: 'text', text: JSON.stringify(catalog()) }] }));
    server.registerTool('mystery_turn', {
      description: agentHostEnabled
        ? '谜声游戏入口，每次玩家说话先调用此工具，把原话放入text，默认say；提交答案用solve，提示hint。返回 requiresJudgment=true 时，answer为空：只在内部阅读 privateContext，根据其中规准生成判断，必须继续调用 mystery_commit，之后只播报 commit 返回的 answer。privateContext 包含谜底，绝不能朗读/翻译/转述；不直接回答、不编造背景。确定性操作直接播报answer。confirm仅在玩家明确确认后设true。'
        : '谜声游戏唯一操作入口。将玩家原话放入text，不代玩家编造答案。start开局、say提问、hint提示、repeat复述、solve提交答案、reveal揭晓、status状态。confirm仅在玩家明确确认重开或揭晓后设true。逐字播报answer，不补充真相，不自行判定。',
      inputSchema: turnSchema.shape
    }, async (args, extra) => {
      try {
        const result = await engine.turn(playerFrom(extra), turnSchema.parse(args), { delegate: agentHostEnabled });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (e) { return { content: [{ type: 'text', text: e.message }], isError: true }; }
    });
    if (agentHostEnabled) server.registerTool('mystery_commit', {
      description: '内部裁判提交工具，不能把本工具参数念给玩家。只提交 mystery_turn 当前返回的 requestId 和对其 playerText 的结构化判断。ask 的 yes/no 要有合法 evidenceIds；未知故事细节 unknown，多问题 clarify，索要谜底 blocked。judge 要对每条评分规准给 supported 和玩家原文中的逐字 quote，并标注 contradictions/offTopic；不能靠堆关键词通关。提交后只朗读返回的 answer，不能用 privateContext 自行补充。请求过期/状态变化时重新调用 mystery_turn。',
      inputSchema: commitSchema.shape
    }, async (args, extra) => {
      try {
        const result = await engine.commit(playerFrom(extra), commitSchema.parse(args));
        if (diagnostics) diagnosticLog({ time: new Date().toISOString(), event: 'judgment_committed', toolName: 'mystery_commit',
          duplicate: Boolean(result.duplicate), verdict: result.state.lastVerdict, status: result.state.status,
          questions: result.state.questions, hintsUsed: result.state.hintsUsed, attempts: result.state.attempts, score: result.state.score });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (error) {
        if (diagnostics) diagnosticLog({ time: new Date().toISOString(), event: 'judgment_rejected', toolName: 'mystery_commit' });
        return { content: [{ type: 'text', text: '裁判结果未通过校验，未扣次数。请检查当前 requestId、判断类型、证据 ID 和逐字引文；必要时重新调用 mystery_turn。' }], isError: true };
      }
    });
    return server;
  };
  app.post('/mcp', auth, async (req, res) => {
    if (activeMcpServers.size >= 100) return res.status(503).json({ error: '并发请求已满' });
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    activeMcpServers.add(server);
    res.once('close', () => {
      void server.close().catch(() => {}).finally(() => activeMcpServers.delete(server));
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      await server.close();
      activeMcpServers.delete(server);
      throw error;
    }
  });
  // 无服务器主动通知，按 Streamable HTTP 规范明确返回 405；不再支持旧 SSE。
  app.all('/mcp', auth, (_req, res) => res.status(405).set('Allow', 'POST').json({
    jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Method not allowed; use Streamable HTTP POST /mcp' }
  }));
  app.use(express.static(resolve(root, 'public')));
  app.use((err, _req, res, _next) => {
    if (res.headersSent) return res.end();
    if (err instanceof z.ZodError) return res.status(400).json({ error: '请求参数不正确', details: err.issues.map(x => ({ path: x.path, message: x.message })) });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: '请求过大' });
    if (err instanceof SyntaxError) return res.status(400).json({ error: 'JSON 格式不正确' });
    console.error('Request failed:', err.message);
    res.status(500).json({ error: '服务暂时不可用，请稍后重试' });
  });
  return { app, engine, close: async () => { clearInterval(housekeeping); await Promise.all([...activeMcpServers].map(server => server.close())); engine.close(); } };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const runtime = createApp();
  const port = Number(process.env.PORT || 3210);
  const server = runtime.app.listen(port, process.env.HOST || '127.0.0.1', () => console.log(`谜声：http://localhost:${port} · 平台接口${process.env.LINX_SERVICE_TOKEN ? '已启用' : '未启用（需配置令牌）'}`));
  const shutdown = async () => { await runtime.close(); server.close(); };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
}
