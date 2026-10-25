import test from 'node:test';
import assert from 'node:assert/strict';
import { projectToolResult, judgmentFailure } from '../src/server.js';
test('裁判失败给出可执行的安全修复分类，不透传任意异常消息', () => {
  const quote = judgmentFailure(new Error('Unexpected quote'));
  assert.equal(quote.reason, 'unsupported_has_quote'); assert.match(quote.instruction, /quote=""/);
  assert.equal(judgmentFailure(new Error('Unverifiable quote')).reason, 'quote_not_in_current_input');
  assert.equal(JSON.stringify(judgmentFailure(new Error('PRIVATE_SECRET'))).includes('PRIVATE_SECRET'), false);
  assert.equal(judgmentFailure(new Error('__proto__')).reason, 'invalid_or_stale_request');
});
test('MCP 工具保留裁判上下文，但不重复携带 UI 历史、旧谜底和回放', () => {
  const result = projectToolResult({ answer: '', requiresJudgment: true, privateContext: { requestId: 'internal', truth: '仅供内部裁判' }, state: {
    gameId: 'game', title: '当前题', status: 'playing', questions: 2, score: null,
    history: [{ text: 'UI-HISTORY' }], replay: { truth: 'UI-REPLAY' }, previousRound: { truth: 'OLD-TRUTH' }, truth: 'NOT-NEEDED'
  } });
  assert.equal(result.requiresJudgment, true); assert.equal(result.privateContext.truth, '仅供内部裁判');
  assert.equal(result.state.questions, 2);
  for (const key of ['history', 'replay', 'previousRound', 'truth']) assert.equal(result.state[key], undefined);
  assert.equal(projectToolResult({ state: null }).state, null);
});
