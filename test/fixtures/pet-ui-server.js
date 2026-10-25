// 仅供 UI 测试的本机 Agent 模拟器；不连接真实灵矽、不读取设备凭据。
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { createPetServer } from '../../src/pet-server.js';
import { GameEngine } from '../../src/engine.js';
const host = {
  ask: async (c, text) => text.includes('衣服')
    ? { verdict: 'unknown', evidenceIds: [], answer: '题目没有交代这一点，无法确定。' }
    : { verdict: 'yes', evidenceIds: [c.id === 'return-route' ? 'orientation' : c.id === 'window-note' ? 'glass' : c.id === 'orange-radio' ? 'recording' : 'light'], answer: '是的。' },
  judge: async () => ({ correct: true, covered: 2 })
};
const engine = new GameEngine(':memory:', null, host), sessions = new Map();
const upstream = createServer(), agent = new WebSocketServer({ server: upstream });
agent.on('connection', socket => {
  const session = randomUUID(); sessions.set(session, session); let audioPackets = 0;
  const answer = async (text, voice = false) => {
    const result = await engine.turn(session, text === '测试静默提示' ? { action: 'hint', text: '给我提示' } : { text });
    if (text === '测试静默提示') return; // UI 超时恢复测试：引擎已处理，但没有 TTS。
    if (socket.readyState !== WebSocket.OPEN) return;
    if (voice) socket.send(JSON.stringify({ type: 'stt', text }));
    socket.send(JSON.stringify({ type: 'tts', state: 'start' }));
    socket.send(JSON.stringify({ type: 'tts', state: 'sentence_start', text: result.answer }));
    for (let i = 0; i < 4; i++) socket.send(Buffer.alloc(640));
    socket.send(JSON.stringify({ type: 'tts', state: 'stop' }));
  };
  socket.on('message', (raw, binary) => {
    if (binary) { audioPackets++; return; }
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'hello') socket.send(JSON.stringify({ type: 'hello', session_id: session, audio_params: { format: 'pcm', sample_rate: 16000, channels: 1 } }));
    else if (msg.type === 'listen' && msg.state === 'detect') void answer(msg.text);
    else if (msg.type === 'listen' && msg.state === 'start') audioPackets = 0;
    else if (msg.type === 'listen' && msg.state === 'stop' && audioPackets > 0) void answer('和光线有关吗？', true);
  });
});
upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
const runtime = createPetServer({
  gameOrigin: 'http://127.0.0.1:3211', noteInput: async () => {},
  identityProvider: () => ({ device_id: '02:11:22:33:44:55', client_id: '9cae72cb-3561-41ab-8732-b95f3e6d77ed' }),
  deviceProvider: async () => ({ bound: true, url: 'wss://fixture.invalid/', token: 'fixture-only-not-a-real-token' }),
  upstreamFactory: (_url, options) => new WebSocket(`ws://127.0.0.1:${upstream.address().port}`, options),
  readGame: async (_identity, session) => ({ state: engine.snapshot(engine.load(sessions.get(session) || 'missing')), judging: false })
});
runtime.server.listen(Number(process.env.PET_TEST_PORT || 3213), '127.0.0.1');
const close = async () => { await runtime.close(); for (const c of agent.clients) c.terminate(); agent.close(); upstream.close(); engine.close(); };
process.once('SIGTERM', close); process.once('SIGINT', close);
