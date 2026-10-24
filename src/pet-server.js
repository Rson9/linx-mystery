import express from 'express';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import { normalizeUtterance } from './device-view.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const identityFile = resolve(root, '.local/lingxi-device.json');
export function loadPetIdentity(path = identityFile) {
  let data;
  try { data = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error('本机设备身份文件无效，请检查 .local/lingxi-device.json');
    const bytes = Buffer.concat([Buffer.from([2]), randomBytes(5)]);
    data = { device_id: [...bytes].map(x => x.toString(16).padStart(2, '0')).join(':').toUpperCase(), client_id: randomUUID() };
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try { writeFileSync(path, JSON.stringify(data), { flag: 'wx', mode: 0o600 }); }
    catch (e) { if (e.code !== 'EEXIST') throw e; return loadPetIdentity(path); }
  }
  if (!/^([a-f\d]{2}:){5}[a-f\d]{2}$/i.test(data.device_id || '') || !/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(data.client_id || '')) throw new Error('本机设备身份格式无效');
  return data;
}

export async function fetchPetDevice(identity, fetchImpl = fetch) {
  const endpoint = new URL(process.env.LINGXI_OTA_URL || 'https://xrobo.qiniuapi.com/v1/ota/');
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) throw new Error('OTA 需要可信 HTTPS 地址');
  const res = await fetchImpl(endpoint, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json', 'Activation-Version': '1', 'Device-Id': identity.device_id,
      'Client-Id': identity.client_id, 'User-Agent': 'misheng-pet/0.2.0', 'Accept-Language': 'zh-CN' },
    body: JSON.stringify({ version: 0, uuid: identity.client_id, mac_address: identity.device_id,
      application: { name: 'misheng-pet', version: '1.0.0', elf_sha256: '0'.repeat(64) },
      board: { type: 'xiaoling-web-test', ssid: 'desktop', rssi: 0, mac: identity.device_id } })
  });
  if (!res.ok) throw new Error('灵矽设备服务暂时不可用');
  const data = await res.json();
  if (data.error) throw new Error('灵矽未接受设备注册');
  if (!data.websocket?.token) return { bound: false, activationCode: String(data.activation?.code || '') };
  const url = new URL(data.websocket.url);
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('平台设备连接地址无效');
  url.protocol = 'wss:';
  return { bound: true, url: url.toString(), token: data.websocket.token };
}

export function projectGame(view) {
  if (!view?.state) return { state: null, judging: false };
  const s = view.state;
  const state = {};
  for (const key of ['gameId', 'caseId', 'title', 'premise', 'status', 'questions', 'hintsUsed', 'attempts', 'score', 'lastVerdict']) state[key] = s[key];
  state.history = (s.history || []).slice(-40).map(x => ({ role: x.role === 'user' ? 'user' : 'assistant', text: String(x.text).slice(0, 4000) }));
  if (['won', 'revealed'].includes(s.status)) state.truth = s.truth;
  return { state, judging: Boolean(view.judging) };
}

function gameReader(origin, token) {
  const endpoint = new URL('/api/device/game', origin);
  if (endpoint.username || endpoint.password || !['https:', 'http:'].includes(endpoint.protocol) || (endpoint.protocol === 'http:' && !['127.0.0.1', 'localhost'].includes(endpoint.hostname))) throw new Error('游戏服务必须是 HTTPS 或本机地址');
  return async (identity, session) => {
    if (!token) return { state: null, judging: false };
    const res = await fetch(endpoint, { redirect: 'error', signal: AbortSignal.timeout(2500), headers: {
      Authorization: `Bearer ${token}`, 'X-Linx-Device-Id': identity.device_id, 'X-Linx-Session-Id': session
    } });
    if (!res.ok) throw new Error('游戏状态暂时无法同步');
    return projectGame(await res.json());
  };
}

function inputRecorder(origin, token) {
  const endpoint = new URL('/api/device/input', origin);
  if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || (endpoint.protocol === 'http:' && !['127.0.0.1', 'localhost'].includes(endpoint.hostname))) throw new Error('输入登记需要可信游戏服务');
  return async (identity, session, input) => {
    if (!token) return;
    const res = await fetch(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(2500),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Linx-Device-Id': identity.device_id, 'X-Linx-Session-Id': session },
      body: JSON.stringify({ inputId: input.inputId, text: input.text }) });
    if (!res.ok) throw new Error('输入登记失败');
  };
}

// 单独监听本机端口，不挂在公网 frp 的游戏服务上，不允许从网页传入任意 URL / token。
export function createPetServer({ identityProvider = loadPetIdentity, deviceProvider = fetchPetDevice,
  upstreamFactory = (url, options) => new WebSocket(url, options),
  readGame = gameReader(process.env.PET_GAME_ORIGIN || `http://127.0.0.1:${process.env.PORT || 3210}`, process.env.LINX_SERVICE_TOKEN),
  noteInput = inputRecorder(process.env.PET_GAME_ORIGIN || `http://127.0.0.1:${process.env.PORT || 3210}`, process.env.LINX_SERVICE_TOKEN),
  gameOrigin = process.env.PET_GAME_ORIGIN || `http://127.0.0.1:${process.env.PORT || 3210}` } = {}) {
  const app = express(), server = createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16384 });
  const sessions = new Map();
  let activePeer = null;
  const port = () => server.address()?.port;
  const hosts = () => new Set([`127.0.0.1:${port()}`, `localhost:${port()}`]);
  const allowedOrigin = req => hosts().has(req.headers.host) && (!req.headers.origin || [`http://127.0.0.1:${port()}`, `http://localhost:${port()}`].includes(req.headers.origin));
  const cookie = req => req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith('pet_session='))?.slice(12);
  const authorized = req => { const value = sessions.get(cookie(req)); return value && value > Date.now(); };
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'microphone=(self), camera=()',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; img-src 'self' data:; media-src 'self' blob:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" });
    if (!allowedOrigin(req)) return res.status(403).json({ error: '本机终端不允许跨站访问' });
    next();
  });
  app.use(express.json({ limit: '4kb' }));
  app.get('/healthz', (_req, res) => res.json({ status: 'ok', service: 'misheng-pet' }));
  app.post('/api/session', (_req, res) => {
    for (const [key, expires] of sessions) if (expires < Date.now()) sessions.delete(key);
    if (sessions.size >= 24) sessions.delete(sessions.keys().next().value);
    const token = randomBytes(32).toString('hex'); sessions.set(token, Date.now() + 3600000);
    res.setHeader('Set-Cookie', `pet_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`);
    res.json({ ok: true });
  });
  app.get('/api/config', async (_req, res) => {
    let engineOnline = false;
    try { engineOnline = (await fetch(new URL('/healthz', gameOrigin), { signal: AbortSignal.timeout(1500) })).ok; } catch {}
    res.json({ localOnly: true, engineOnline, audio: 'pcm16-mono-16000', voiceProvider: 'lingxi', microphoneAutomatic: false });
  });
  app.use(express.static(resolve(root, 'public/pet')));
  app.use((error, _req, res, _next) => res.status(400).json({ error: '请求格式不正确' }));

  server.on('upgrade', (req, socket, head) => {
    const reject = (status, label) => socket.end(`HTTP/1.1 ${status} ${label}\r\nConnection: close\r\n\r\n`);
    if (req.url !== '/voice') return reject(404, 'Not Found');
    if (!allowedOrigin(req) || !req.headers.origin || !authorized(req)) return reject(403, 'Forbidden');
    if (activePeer?.readyState === WebSocket.OPEN) return reject(409, 'Device Busy');
    wss.handleUpgrade(req, socket, head, peer => { activePeer = peer; wss.emit('connection', peer, req); });
  });
  wss.on('connection', async peer => {
    let upstream, ready = false, recording = false, recordingSince = 0, session, identity;
    let currentInput = null, intentEpoch = 0;
    let poller, heartbeat, helloTimer, lastPong = Date.now(), lastPing = 0, reading = false, lastView = '', warned = false;
    const send = data => { if (peer.readyState === WebSocket.OPEN) peer.send(JSON.stringify(data)); };
    const fail = message => { send({ type: 'error', message }); peer.close(1011, 'Voice connection failed'); };
    const upstreamJson = value => { if (upstream?.readyState === WebSocket.OPEN) upstream.send(JSON.stringify(value)); };
    const control = (type, fields = {}) => ({ session_id: session, type, ...fields });
    peer.on('close', () => {
      if (activePeer === peer) activePeer = null;
      clearInterval(poller); clearInterval(heartbeat); clearTimeout(helloTimer);
      upstream?.terminate();
    });
    peer.on('error', () => {});
    peer.on('message', async (raw, binary) => {
      if (!ready) return;
      if (upstream?.bufferedAmount > 1024 * 1024 || peer.bufferedAmount > 1024 * 1024) return fail('网络积压，请断开后重新唤醒');
      if (binary) {
        if (!recording || raw.length !== 640) return;
        upstream.send(raw); return;
      }
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
      if (msg.type === 'record' && msg.state === 'start' && !recording) {
        intentEpoch++; currentInput = { inputId: randomUUID(), text: null, source: 'voice' };
        upstreamJson(control('abort', { reason: 'wake_word_detected' }));
        upstreamJson(control('listen', { state: 'start', mode: 'manual' }));
        recording = true; recordingSince = Date.now();
      } else if (msg.type === 'record' && msg.state === 'stop' && recording) {
        recording = false; upstreamJson(control('listen', { state: 'stop', mode: 'manual' }));
      } else if (msg.type === 'abort') {
        intentEpoch++; currentInput = null; recording = false; upstreamJson(control('abort', { reason: 'wake_word_detected' }));
      } else if (msg.type === 'say' && typeof msg.text === 'string' && msg.text.trim() && msg.text.length <= 1200 && !recording) {
        const generation = ++intentEpoch;
        currentInput = { inputId: randomUUID(), text: msg.text.trim(), source: 'text' };
        try { await noteInput(identity, session, currentInput); }
        catch { return fail('无法登记本次操作，已停止发送以避免重复扣分，请重新连接'); }
        if (generation !== intentEpoch || peer.readyState !== WebSocket.OPEN) return;
        upstreamJson(control('abort', { reason: 'wake_word_detected' }));
        upstreamJson(control('listen', { state: 'detect', text: msg.text.trim() }));
      }
    });
    try {
      identity = identityProvider();
      send({ type: 'status', state: 'connecting' });
      const device = await deviceProvider(identity);
      if (peer.readyState !== WebSocket.OPEN) return;
      if (!device.bound) {
        send({ type: 'activation', code: device.activationCode }); peer.close(4001, 'Activation required'); return;
      }
      upstream = upstreamFactory(device.url, { headers: { Authorization: `Bearer ${device.token}`, 'Device-Id': identity.device_id,
        'Client-Id': identity.client_id, 'Protocol-Version': '1' }, handshakeTimeout: 15000, maxPayload: 1024 * 1024 });
      helloTimer = setTimeout(() => fail('连接灵矽超时，请检查网络后重试'), 20000).unref();
      upstream.on('open', () => upstreamJson({ type: 'hello', version: 1, transport: 'websocket', features: { mcp: false },
        audio_params: { format: 'pcm', sample_rate: 16000, channels: 1, bit_depth: 16, endianness: 'little',
          frame_duration: 20, frame_size: 320, sample_format: 'signed_int16', play_buffer_duration: 1000 } }));
      upstream.on('pong', () => { lastPong = Date.now(); });
      upstream.on('error', () => fail('灵矽连接失败，请检查设备绑定和网络'));
      upstream.on('close', () => { if (peer.readyState === WebSocket.OPEN) fail('灵矽会话已结束，请重新唤醒小矽'); });
      upstream.on('message', (raw, binary) => {
        if (binary) {
          if (ready && !recording && peer.readyState === WebSocket.OPEN) {
            if (peer.bufferedAmount > 1024 * 1024) return fail('音频传输积压，请重新连接');
            peer.send(raw);
          }
          return;
        }
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
        if (msg.type === 'hello') {
          if (msg.audio_params?.format !== 'pcm' || msg.audio_params.sample_rate !== 16000 || (msg.audio_params.channels || 1) !== 1 || !msg.session_id) return fail('平台音频格式不兼容，需要单声道 16kHz PCM');
          session = msg.session_id; ready = true; clearTimeout(helloTimer);
          send({ type: 'ready', sampleRate: 16000, channels: 1, format: 'pcm' });
          poller = setInterval(async () => {
            if (reading || peer.readyState !== WebSocket.OPEN) return;
            reading = true;
            try {
              const view = projectGame(await readGame(identity, session));
              const serialized = JSON.stringify(view);
              if (serialized !== lastView) { send({ type: 'game', ...view }); lastView = serialized; }
            } catch { if (!warned) { send({ type: 'note', message: '语音已连接，游戏状态暂时无法同步' }); warned = true; } }
            finally { reading = false; }
          }, 750).unref();
          heartbeat = setInterval(() => {
            if (Date.now() - lastPong > 90000) return fail('连接保活超时，请重新唤醒');
            if (upstream.readyState === WebSocket.OPEN && Date.now() - lastPing >= 20000) { upstream.ping(); lastPing = Date.now(); }
            if (recording && Date.now() - recordingSince > 45000) {
              recording = false; upstreamJson(control('listen', { state: 'stop', mode: 'manual' })); send({ type: 'record_limit' });
            }
          }, 1000).unref();
        } else if (msg.type === 'stt' && typeof msg.text === 'string') {
          const text = msg.text.slice(0, 1200);
          if (currentInput?.source === 'voice' && normalizeUtterance(currentInput.text || '') !== normalizeUtterance(text)) {
            const input = { ...currentInput, inputId: currentInput.text ? randomUUID() : currentInput.inputId, text };
            currentInput = input;
            void noteInput(identity, session, input).catch(() => send({ type: 'note', message: '语音已识别，但输入去重登记未成功，请避免连续重复操作' }));
          }
          send({ type: 'stt', text });
        }
        else if (msg.type === 'tts') send({ type: 'tts', state: msg.state, text: typeof msg.text === 'string' ? msg.text.slice(0, 4000) : '', is_aborted: Boolean(msg.is_aborted) });
        else if (msg.type === 'error' || msg.type === 'goodbye') fail('平台暂时无法继续会话，请重新唤醒');
        // 不转发 mcp / custom 或任意 JSON；内部主持资料不能进入桌宠网页。
      });
    } catch { fail('无法连接设备，请检查网络或运行 pnpm voice:activate 完成绑定'); }
  });
  const close = async () => {
    for (const peer of wss.clients) peer.terminate();
    wss.close();
    server.closeAllConnections();
    if (server.listening) await new Promise(r => server.close(r));
  };
  return { app, server, close };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const runtime = createPetServer();
  const port = Number(process.env.PET_PORT || 3212);
  runtime.server.on('error', () => { console.error('桌宠端口不可用，请关闭旧窗口对应的服务，或更改 PET_PORT。'); process.exitCode = 1; });
  runtime.server.listen(port, '127.0.0.1', () => console.log(`小矽桌宠：http://127.0.0.1:${port} · 仅本机 · 点击后才打开麦克风`));
  process.once('SIGINT', () => runtime.close()); process.once('SIGTERM', () => runtime.close());
}
