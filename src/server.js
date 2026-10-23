import express from 'express';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { GameEngine } from './engine.js';
import { createAIHost } from './host.js';
import { catalog } from './cases.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const actions = ['say', 'start', 'hint', 'repeat', 'solve', 'reveal', 'status', 'list'];
const turnSchema = z.object({ action: z.enum(actions).default('say'), text: z.string().max(1200).default(''), caseId: z.string().max(80).optional(), confirm: z.boolean().default(false) }).strict();
const idSchema = z.string().min(1).max(128).regex(/^[\w.:-]+$/);
const identity = (device, agent, session) => {
  if (!idSchema.safeParse(device).success || !idSchema.safeParse(session).success || (agent && !idSchema.safeParse(agent).success)) throw new Error('缺少或无效的设备 / 会话标识');
  return `linx:${createHash('sha256').update(JSON.stringify([device, agent || '', session])).digest('hex')}`;
};
const equal = (a, b) => {
  const aa = Buffer.from(a || ''), bb = Buffer.from(b || '');
  return aa.length === bb.length && timingSafeEqual(aa, bb);
};

export function createApp({ dbPath = process.env.DB_PATH || resolve(root, 'data/games.sqlite'), token = process.env.LINX_SERVICE_TOKEN, semantic = null, host = process.env.AI_HOST_ENABLED === '1' ? createAIHost({ url: process.env.LLM_BASE_URL, key: process.env.LLM_API_KEY, model: process.env.LLM_MODEL }) : null, publicOrigin = process.env.PUBLIC_ORIGIN, diagnostics = process.env.MCP_DIAGNOSTICS === '1', diagnosticLog = entry => console.info('[mcp]', JSON.stringify(entry)) } = {}) {
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
          rpcMethod: methods.includes(req.body?.method) ? req.body.method : null });
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
  app.get('/api/catalog', (_req, res) => res.json({ cases: catalog(), semantic: Boolean(semantic || host), hostMode: host ? 'ai' : 'rules', voice: 'browser-preview' }));
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
    server.registerTool('mystery_catalog', { description: '列出谜声的可玩谜题，不包含谜底。', inputSchema: {} }, async () => ({ content: [{ type: 'text', text: JSON.stringify(catalog()) }] }));
    server.registerTool('mystery_turn', {
      description: '谜声游戏唯一操作入口。将玩家原话放入text，不代玩家编造答案。start开局、say提问、hint提示、repeat复述、solve提交答案、reveal揭晓、status状态。confirm仅在玩家明确确认重开或揭晓后设true。逐字播报answer，不补充真相，不自行判定。',
      inputSchema: turnSchema.shape
    }, async (args, extra) => {
      try {
        const headers = extra.requestInfo?.headers || {};
        const device = headers['x-linx-device-id'];
        const agent = headers['x-linx-agent-id'];
        const session = headers['x-linx-session-id'];
        const result = await engine.turn(identity(device, agent, session), turnSchema.parse(args));
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (e) { return { content: [{ type: 'text', text: e.message }], isError: true }; }
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
