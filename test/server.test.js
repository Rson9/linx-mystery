import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { createApp } from '../src/server.js';

async function setup(t, options = {}) {
  const runtime = createApp({ dbPath: ':memory:', token: 'test-secret', semantic: null, ...options });
  const server = runtime.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await runtime.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { ...runtime, base: `http://127.0.0.1:${server.address().port}` };
}
const post = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
test('网页 API 使用 HttpOnly cookie、可恢复状态、不泄漏真相', async t => {
  const { base } = await setup(t);
  const response = await fetch(`${base}/api/state`); const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
  const result = await post(`${base}/api/turn`, { action: 'start' }, { Cookie: cookie.split(';')[0] });
  assert.equal(result.status, 200); assert.equal((await result.json()).state.truth, undefined);
  const saved = await fetch(`${base}/api/state`, { headers: { Cookie: cookie.split(';')[0] } }); assert.equal((await saved.json()).state.caseId, 'silent-bell');
  const catalog = await (await fetch(`${base}/api/catalog`)).text(); assert.ok(!catalog.includes('concepts')); assert.ok(!catalog.includes('truth'));
});
test('认证、CSRF、参数和消息体大小限制', async t => {
  const { base } = await setup(t);
  assert.equal((await post(`${base}/api/chat/stream`, {})).status, 401);
  assert.equal((await post(`${base}/api/turn`, { action: 'erase' })).status, 400);
  assert.equal((await post(`${base}/api/turn`, {}, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post(`${base}/api/turn`, { text: 'x'.repeat(20000) })).status, 413);
  assert.equal((await fetch(`${base}/mcp/message?sessionId=unknown`, { method: 'POST', headers: { Authorization: 'Bearer test-secret' } })).status, 404);
});
test('未配置平台令牌时接口关闭', async t => {
  const { base } = await setup(t, { token: '' });
  assert.equal((await post(`${base}/api/chat/stream`, {})).status, 503);
});
test('灵矽业务 SSE 保留 session_id，设备和会话隔离', async t => {
  const { base } = await setup(t);
  const chat = async (device, session, msg) => {
    const res = await post(`${base}/api/chat/stream`, { auth: { device_id: device }, type: 'chat', details: { session_id: session, msg } }, { Authorization: 'Bearer test-secret' });
    assert.equal(res.status, 200); assert.match(res.headers.get('content-type'), /text\/event-stream/);
    return (await res.text()).trim().split('\n\n').map(s => JSON.parse(s.slice(6)));
  };
  const first = await chat('device-a', 'session-a', '开始游戏'); assert.equal(first[0].session_id, 'session-a'); assert.equal(first[1].event, 'message_end');
  assert.match((await chat('device-a', 'session-a', '给我提示'))[0].details.answer, /提示 1/);
  assert.match((await chat('device-b', 'session-a', '给我提示'))[0].details.answer, /开始游戏/);
  assert.match((await chat('device-a', 'session-b', '给我提示'))[0].details.answer, /开始游戏/);
});
test('官方 MCP 客户端完成 SSE 初始化、工具发现及游戏调用', { timeout: 15000 }, async t => {
  const { base } = await setup(t);
  const headers = { Authorization: 'Bearer test-secret', 'X-Linx-Device-Id': 'mcp-device', 'X-Linx-Agent-Id': 'mcp-agent', 'X-Linx-Session-Id': 'mcp-session' };
  const transport = new SSEClientTransport(new URL(`${base}/mcp`), { requestInit: { headers }, eventSourceInit: { fetch: (url, init) => { const merged = new Headers(init?.headers); for (const [key, value] of Object.entries(headers)) merged.set(key, value); return fetch(url, { ...init, headers: merged }); } } });
  const client = new Client({ name: 'integration-test', version: '1.0' }); t.after(() => client.close());
  await client.connect(transport);
  const tools = await client.listTools(); assert.ok(tools.tools.some(t => t.name === 'mystery_turn'));
  let result = await client.callTool({ name: 'mystery_turn', arguments: { action: 'start' } });
  assert.ok(!result.isError); assert.equal(JSON.parse(result.content[0].text).state.caseId, 'silent-bell');
  result = await client.callTool({ name: 'mystery_turn', arguments: { text: '和灯光有关吗？' } });
  assert.match(JSON.parse(result.content[0].text).answer, /闪光灯/);
  await client.close();
});
test('MCP 诊断区分认证失败且不记录令牌、查询串、身份或工具参数', async t => {
  const logs = [];
  const { base } = await setup(t, { diagnostics: true, diagnosticLog: entry => logs.push(entry) });
  const result = await post(`${base}/mcp/message?sessionId=private-session&api_key=private-key`,
    { method: 'tools/call', params: { secret: 'private-argument' } },
    { Authorization: 'Bearer wrong-secret', 'X-Linx-Device-Id': 'private-device', 'X-Linx-Session-Id': 'private-session' });
  assert.equal(result.status, 401);
  assert.ok(logs.some(x => x.event === 'closed' && x.status === 401 && x.authValid === false && x.rpcMethod === 'tools/call'));
  const serialized = JSON.stringify(logs);
  for (const secret of ['wrong-secret', 'private-session', 'private-key', 'private-argument', 'private-device']) assert.ok(!serialized.includes(secret));
});
test('MCP 缺少设备身份只能发现工具，不能创建游戏', { timeout: 15000 }, async t => {
  const { base } = await setup(t);
  const headers = { Authorization: 'Bearer test-secret' };
  const transport = new SSEClientTransport(new URL(`${base}/mcp`), { requestInit: { headers }, eventSourceInit: { fetch: (url, init) => fetch(url, { ...init, headers }) } });
  const client = new Client({ name: 'no-identity', version: '1' }); t.after(() => client.close()); await client.connect(transport);
  assert.ok((await client.listTools()).tools.length > 0);
  const result = await client.callTool({ name: 'mystery_turn', arguments: { action: 'start' } }); assert.equal(result.isError, true);
  await client.close();
});
