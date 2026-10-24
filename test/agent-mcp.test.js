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
  const args = { requestId: p.privateContext.requestId, judgment: { kind: 'ask', verdict: 'unknown', evidenceIds: [] } };
  const other = await connect('device-b'); assert.equal((await other.callTool({ name: 'mystery_commit', arguments: args })).isError, true);
  const r = await call(client, 'mystery_commit', args); assert.match(r.answer, /无法确定/); assert.equal(r.privateContext, undefined);
  assert.equal((await call(client, 'mystery_commit', args)).duplicate, true);
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
test('关闭 Agent 模式时不暴露 commit 工具，旧规则流程不受影响', async t => {
  const { connect } = await setup(t, false); const client = await connect();
  assert.ok(!(await client.listTools()).tools.some(x => x.name === 'mystery_commit'));
  await call(client, 'mystery_turn', { text: '开始游戏' });
  const r = await call(client, 'mystery_turn', { text: '和灯光有关吗？' });
  assert.match(r.answer, /闪光灯/); assert.equal(r.requiresJudgment, undefined);
});
