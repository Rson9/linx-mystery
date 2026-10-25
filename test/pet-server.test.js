import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { createPetServer, loadPetIdentity, projectGame } from '../src/pet-server.js';
const identity = { device_id: '02:11:22:33:44:55', client_id: '9cae72cb-3561-41ab-8732-b95f3e6d77ed' };
async function setup(t, options = {}) {
  const upstreamHttp = createServer(), agent = new WebSocketServer({ server: upstreamHttp });
  const received = [], headers = [];
  agent.on('connection', (socket, req) => {
    headers.push(req.headers);
    socket.on('message', (raw, binary) => {
      received.push(binary ? Buffer.from(raw) : JSON.parse(raw.toString()));
      if (binary) return;
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'hello') socket.send(JSON.stringify({ type: 'hello', session_id: 'pet-session', audio_params: { format: 'pcm', sample_rate: 16000, channels: 1 } }));
      else if (msg.type === 'listen' && msg.state === 'detect') {
        for (const m of [{ type: 'mcp', privateContext: 'SECRET_HOST_CONTEXT' }, { type: 'tts', state: 'start' }, { type: 'tts', state: 'sentence_start', text: '真实协议测试' }]) socket.send(JSON.stringify(m));
        socket.send(Buffer.alloc(640)); socket.send(JSON.stringify({ type: 'tts', state: 'stop' }));
      }
    });
  });
  upstreamHttp.listen(0, '127.0.0.1'); await once(upstreamHttp, 'listening');
  const runtime = createPetServer({ identityProvider: () => identity, noteInput: async () => {},
    deviceProvider: async () => ({ bound: true, url: 'wss://upstream.example/ws', token: 'PRIVATE_DEVICE_TOKEN' }),
    upstreamFactory: (_url, options) => new WebSocket(`ws://127.0.0.1:${upstreamHttp.address().port}`, options),
    readGame: async () => ({ state: { gameId: 'game', title: '没有响的门铃', status: 'playing', history: [], truth: 'HIDDEN_TRUTH', privateContext: 'HIDDEN_HOST', pendingJudgment: 'HIDDEN_PENDING' }, judging: true }), ...options });
  runtime.server.listen(0, '127.0.0.1'); await once(runtime.server, 'listening');
  t.after(async () => { await runtime.close(); for (const c of agent.clients) c.terminate(); agent.close(); await new Promise(r => upstreamHttp.close(r)); });
  const base = `http://127.0.0.1:${runtime.server.address().port}`;
  const session = await fetch(`${base}/api/session`, { method: 'POST', headers: { Origin: base } });
  return { ...runtime, base, received, headers, agent, cookie: session.headers.get('set-cookie').split(';')[0] };
}
async function connect(base, cookie) {
  const peer = new WebSocket(base.replace('http:', 'ws:') + '/voice', { headers: { Origin: base, ...(cookie ? { Cookie: cookie } : {}) } });
  const messages = []; peer.on('error', () => {}); peer.on('message', (data, binary) => messages.push(binary ? Buffer.from(data) : JSON.parse(data.toString())));
  await once(peer, 'open');
  const wait = async predicate => { for (let i = 0; i < 150; i++) { const found = messages.find(predicate); if (found) return found; await new Promise(r => setTimeout(r, 10)); } throw new Error('Missing expected message'); };
  await wait(x => x.type === 'ready'); return { peer, messages, wait };
}
test('桌宠身份沿用本地虚拟设备、权限 0600，公开投影不带主持资料', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pet-id-'));
  try { const path = join(dir, 'identity.json'); const a = loadPetIdentity(path); assert.deepEqual(loadPetIdentity(path), a); assert.equal(statSync(path).mode & 0o777, 0o600); assert.ok(a.device_id.startsWith('02:')); }
  finally { rmSync(dir, { recursive: true }); }
  const projected = projectGame({ state: { status: 'playing', history: [], truth: 'secret', solution: 'secret', privateContext: 'secret' } });
  assert.ok(!JSON.stringify(projected).includes('secret'));
});
test('本机 Host/Origin 限制和 HttpOnly 能力 Cookie，未授权不能连接语音', async t => {
  const { base } = await setup(t);
  assert.equal((await fetch(`${base}/healthz`, { headers: { Origin: 'https://evil.example' } })).status, 403);
  const rebindingStatus = await new Promise((resolve, reject) => {
    const req = httpRequest(`${base}/healthz`, { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(rebindingStatus, 403);
  const response = await fetch(`${base}/api/session`, { method: 'POST', headers: { Origin: base } });
  assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const denied = new WebSocket(base.replace('http:', 'ws:') + '/voice', { headers: { Origin: base } }); denied.on('error', () => {});
  const [_, res] = await once(denied, 'unexpected-response'); assert.equal(res.statusCode, 403); res.resume(); denied.terminate();
});
test('PCM、按钮指令和状态桥接真实 WS 协议，不把设备令牌或 MCP 私有字段给浏览器', async t => {
  const { base, cookie, received, headers } = await setup(t);
  const { peer, messages, wait } = await connect(base, cookie);
  assert.equal(headers[0].authorization, 'Bearer PRIVATE_DEVICE_TOKEN');
  assert.equal(received[0].audio_params.format, 'pcm');
  peer.send('null'); peer.send('42');
  peer.send(JSON.stringify({ type: 'record', state: 'start' })); peer.send(Buffer.alloc(640)); peer.send(JSON.stringify({ type: 'record', state: 'stop' }));
  peer.send(JSON.stringify({ type: 'say', text: '开始游戏', url: 'https://evil.example' }));
  await wait(x => x.type === 'tts' && x.state === 'stop');
  const game = await wait(x => x.type === 'game'); assert.equal(game.judging, true);
  assert.ok(received.some(x => Buffer.isBuffer(x) && x.length === 640));
  assert.ok(received.some(x => x.type === 'listen' && x.state === 'detect' && x.text === '开始游戏' && !x.url && !x.text_response));
  const text = JSON.stringify(messages.filter(x => !Buffer.isBuffer(x)));
  for (const secret of ['PRIVATE_DEVICE_TOKEN', 'SECRET_HOST_CONTEXT', 'HIDDEN_TRUTH', 'HIDDEN_HOST', 'HIDDEN_PENDING']) assert.ok(!text.includes(secret));
  peer.close();
});
test('未确认开局最多重发一次，仍使用同一输入登记，不重置输入凭据', async t => {
  const inputs = [];
  const { base, cookie, received } = await setup(t, { startupRetryMs: 30, readGame: async () => ({ state: null }), noteInput: async (_id, _session, input) => inputs.push(input) });
  const { peer } = await connect(base, cookie);
  peer.send(JSON.stringify({ type: 'say', text: '开始谜声游戏《回不去的三句话》' }));
  await new Promise(r => setTimeout(r, 600));
  const attempts = received.filter(x => x.type === 'listen' && x.state === 'detect');
  assert.equal(attempts.length, 2); assert.equal(inputs.length, 1); assert.equal(attempts[0].text, attempts[1].text);
  await new Promise(r => setTimeout(r, 100));
  assert.equal(received.filter(x => x.type === 'listen' && x.state === 'detect').length, 2);
  peer.close();
});
test('模型把工具调用写成文本时停止输出，不把函数名或参数当游戏语音播放', async t => {
  const { base, cookie, agent } = await setup(t);
  const { peer, messages, wait } = await connect(base, cookie), upstream = [...agent.clients][0];
  const closed = once(peer, 'close');
  upstream.send(JSON.stringify({ type: 'tts', state: 'start' }));
  upstream.send(JSON.stringify({ type: 'tts', state: 'sentence_start', text: 'mystery_turn(text="开始游戏", action="start")' }));
  upstream.send(Buffer.alloc(640));
  const error = await wait(x => x.type === 'error'); assert.match(error.message, /工具调用文本/);
  await closed;
  assert.equal(messages.some(x => Buffer.isBuffer(x) || x.text?.includes('mystery_turn(')), false);
});
test('新播报必须从 tts.start 开始；打断后的旧句尾和 PCM 不串入下一轮', async t => {
  const { base, cookie, agent, received } = await setup(t);
  const { peer, messages, wait } = await connect(base, cookie), upstream = [...agent.clients][0];
  upstream.send(JSON.stringify({ type: 'tts', state: 'sentence_start', text: 'STALE-TAIL' })); upstream.send(Buffer.alloc(640, 11));
  upstream.send(JSON.stringify({ type: 'tts', state: 'start' }));
  upstream.send(JSON.stringify({ type: 'tts', state: 'sentence_start', text: 'CURRENT' })); upstream.send(Buffer.alloc(640, 22));
  await wait(x => Buffer.isBuffer(x) && x[0] === 22);
  assert.equal(messages.some(x => x.text === 'STALE-TAIL' || (Buffer.isBuffer(x) && x[0] === 11)), false);
  peer.send(JSON.stringify({ type: 'abort' }));
  for (let i = 0; i < 50 && !received.some(x => x.type === 'abort'); i++) await new Promise(r => setTimeout(r, 10));
  upstream.send(JSON.stringify({ type: 'tts', state: 'sentence_start', text: 'AFTER-ABORT-TAIL' })); upstream.send(Buffer.alloc(640, 33));
  await new Promise(r => setTimeout(r, 50));
  assert.equal(messages.some(x => x.text === 'AFTER-ABORT-TAIL' || (Buffer.isBuffer(x) && x[0] === 33)), false);
  peer.close();
});
