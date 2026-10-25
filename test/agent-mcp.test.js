import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/server.js';
async function setup(t, enabled = true, options = {}) {
  const runtime = createApp({ dbPath: ':memory:', token: 'test-secret', host: null, agentHostEnabled: enabled, ...options });
  const server = runtime.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await runtime.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const connect = async (device = 'device-a') => {
    const client = new Client({ name: 'agent-host-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: {
      Authorization: 'Bearer test-secret', 'X-Linx-Device-Id': device, 'X-Linx-Agent-Id': 'agent-a', 'X-Linx-Session-Id': 'session-a'
    } } }));
    t.after(() => client.close()); return client;
  };
  return { ...runtime, base, connect };
}
const call = async (client, name, args) => {
  const r = await client.callTool({ name, arguments: args });
  assert.ok(!r.isError, r.content[0].text);
  return JSON.parse(r.content[0].text);
};
test('真实 MCP 协议两阶段调用、重试与会话隔离，网页不提供内部主持资料', async t => {
  const entries = [];
  const { base, connect } = await setup(t, true, { diagnostics: true, diagnosticLog: entry => entries.push(entry) }); const client = await connect();
  assert.ok((await client.listTools()).tools.some(x => x.name === 'mystery_commit'));
  await call(client, 'mystery_turn', { text: '开始游戏' });
  const p = await call(client, 'mystery_turn', { text: '他提前和快递员约好了吗？' });
  assert.equal(p.requiresJudgment, true); assert.ok(p.privateContext.truth);
  const viewHeaders = { Authorization: 'Bearer test-secret', 'X-Linx-Device-Id': 'device-a', 'X-Linx-Session-Id': 'session-a' };
  assert.equal((await fetch(`${base}/api/device/game`)).status, 401);
  const view = await (await fetch(`${base}/api/device/game`, { headers: viewHeaders })).json();
  assert.equal(view.judging, true); assert.equal(view.state.title, '没有响的门铃');
  for (const key of ['truth', 'privateContext', 'solution', 'pendingJudgment']) assert.equal(view.state[key], undefined);
  const isolated = await (await fetch(`${base}/api/device/game`, { headers: { ...viewHeaders, 'X-Linx-Device-Id': 'different-device' } })).json();
  assert.equal(isolated.state, null);
  const args = { requestId: p.privateContext.requestId, judgment: { kind: 'ask', verdict: 'unknown', evidenceIds: [] } };
  const other = await connect('device-b'); assert.equal((await other.callTool({ name: 'mystery_commit', arguments: args })).isError, true);
  const r = await call(client, 'mystery_commit', args); assert.match(r.answer, /无法确定/); assert.equal(r.privateContext, undefined);
  assert.equal((await call(client, 'mystery_commit', args)).duplicate, true);
  assert.equal((await (await fetch(`${base}/api/device/game`, { headers: viewHeaders })).json()).judging, false);
  const catalog = await (await fetch(`${base}/api/catalog`)).json();
  assert.equal(catalog.hostMode, 'rules'); assert.equal(catalog.mcpHostMode, 'agent');
  for (const item of catalog.cases) for (const key of ['truth', 'solution', 'facts', 'privateContext']) assert.equal(item[key], undefined);
  const web = await (await fetch(`${base}/api/state`)).json(); assert.equal(web.state, null);
  assert.ok(entries.some(x => x.event === 'judgment_committed' && x.verdict === 'unknown' && x.questions === 0));
  assert.ok(entries.some(x => x.event === 'judgment_rejected'));
  assert.ok(!JSON.stringify(entries).includes(p.privateContext.truth));
  assert.ok(!JSON.stringify(entries).includes(p.privateContext.requestId));
});
test('工具提交拒绝额外文本字段；不知道 requestId 不能注入判断', async t => {
  const { connect } = await setup(t); const client = await connect();
  const r = await client.callTool({ name: 'mystery_commit', arguments: { requestId: '3a78ee42-341d-4a69-8001-78067cd5ee5b',
    judgment: { kind: 'ask', verdict: 'yes', evidenceIds: ['truth'], answer: '私有文本' } } });
  assert.equal(r.isError, true);
});
test('桌宠同一次提示输入的工具重试不重复扣分，第二次真实输入仍可取下一提示', async t => {
  const { base, connect } = await setup(t); const client = await connect();
  const headers = { Authorization: 'Bearer test-secret', 'Content-Type': 'application/json', 'X-Linx-Device-Id': 'device-a', 'X-Linx-Session-Id': 'session-a' };
  const register = async (inputId, text) => {
    const r = await fetch(`${base}/api/device/input`, { method: 'POST', headers, body: JSON.stringify({ inputId, text }) });
    assert.equal(r.status, 200);
  };
  await call(client, 'mystery_turn', { text: '开始游戏' });
  await register('0b634f72-355f-442e-b5e5-47122fa990d6', '给我提示');
  assert.equal((await call(client, 'mystery_turn', { action: 'hint' })).state.hintsUsed, 1);
  const duplicate = await call(client, 'mystery_turn', { text: '给我提示。' });
  assert.equal(duplicate.duplicateInput, true); assert.equal(duplicate.state.hintsUsed, 1);
  const mismatch = await client.callTool({ name: 'mystery_turn', arguments: { text: '揭晓答案' } });
  assert.equal(mismatch.isError, true);
  const correction = JSON.parse(mismatch.content[0].text);
  assert.equal(correction.error, 'input_mismatch'); assert.equal(correction.playerText, '给我提示');
  assert.equal((await call(client, 'mystery_turn', { text: correction.playerText })).state.hintsUsed, 1);
  await register('e99b8f82-f340-4b02-b907-680249382745', '给我提示');
  assert.equal((await call(client, 'mystery_turn', { action: 'hint' })).state.hintsUsed, 2);
});
test('原话不匹配反馈给出当前设备文本，改正后才能判题，重试不会重复计数', async t => {
  const entries = [];
  const { base, connect } = await setup(t, true, { diagnostics: true, diagnosticLog: entry => entries.push(entry) });
  const client = await connect(), text = '回来时方向是相反的吗？';
  await call(client, 'mystery_turn', { text: '开始回不去的三句话' });
  const headers = { Authorization: 'Bearer test-secret', 'Content-Type': 'application/json', 'X-Linx-Device-Id': 'device-a', 'X-Linx-Session-Id': 'session-a' };
  await fetch(`${base}/api/device/input`, { method: 'POST', headers, body: JSON.stringify({ inputId: '18ed0036-8dfb-484b-b88c-f8ca12ce59c7', text }) });
  const bad = await client.callTool({ name: 'mystery_turn', arguments: { action: 'hint', text: '回程方向相反吗？' } });
  assert.equal(bad.isError, true); const correction = JSON.parse(bad.content[0].text);
  assert.equal(correction.playerText, text);
  const before = await (await fetch(`${base}/api/device/game`, { headers })).json();
  assert.equal(before.state.questions, 0); assert.equal(before.state.hintsUsed, 0);
  const corrected = await call(client, 'mystery_turn', { text: correction.playerText });
  assert.equal(corrected.answer, '是的。'); assert.equal(corrected.state.questions, 1);
  assert.equal((await call(client, 'mystery_turn', { text })).state.questions, 1);
  assert.ok(entries.some(e => e.event === 'turn_rejected' && e.reason === 'input_mismatch'));
  assert.equal(JSON.stringify(entries).includes(text), false);
});
test('新设备输入会让旧的异步裁判提交失效', async t => {
  const { base, connect } = await setup(t); const client = await connect();
  const headers = { Authorization: 'Bearer test-secret', 'Content-Type': 'application/json', 'X-Linx-Device-Id': 'device-a', 'X-Linx-Session-Id': 'session-a' };
  const register = async (inputId, text) => fetch(`${base}/api/device/input`, { method: 'POST', headers, body: JSON.stringify({ inputId, text }) });
  await call(client, 'mystery_turn', { text: '开始游戏' });
  await register('10a23370-a6e8-4376-a85c-0c48051cefe4', '听力正常吗');
  const p = await call(client, 'mystery_turn', { text: '听力正常吗' });
  await register('9386b5c9-a60c-4f8e-8fee-b67ab9cf180b', '衣服是蓝色吗');
  const stale = await client.callTool({ name: 'mystery_commit', arguments: { requestId: p.privateContext.requestId, judgment: { kind: 'ask', verdict: 'no', evidenceIds: ['hearing'] } } });
  assert.equal(stale.isError, true);
});
test('关闭 Agent 模式时不暴露 commit 工具，旧规则流程不受影响', async t => {
  const { connect } = await setup(t, false); const client = await connect();
  assert.ok(!(await client.listTools()).tools.some(x => x.name === 'mystery_commit'));
  await call(client, 'mystery_turn', { text: '开始游戏' });
  const r = await call(client, 'mystery_turn', { text: '和灯光有关吗？' });
  assert.match(r.answer, /闪光灯/); assert.equal(r.requiresJudgment, undefined);
});
