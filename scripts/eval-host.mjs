import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createAIHost } from '../src/host.js';
import { cases } from '../src/cases.js';
import { hostExamples } from '../eval/host-cases.js';
const host = createAIHost({ url: process.env.LLM_BASE_URL, key: process.env.LLM_API_KEY, model: process.env.LLM_MODEL, reasoningEffort: process.env.LLM_REASONING_EFFORT || undefined });
if (!host) {
  console.error('未配置服务端模型。请在本机 .env 设置 LLM_BASE_URL、LLM_API_KEY、LLM_MODEL。没有执行模型评测，不能声明自由问答质量达标。');
  process.exit(2);
}
const results = [];
for (const example of hostExamples) {
  const c = cases.find(x => x.id === example.caseId);
  const started = performance.now();
  let actual = null, valid = true, errorKind = null, httpStatus = null;
  try {
    const reply = example.task === 'ask' ? await host.ask(c, example.text) : await host.judge(c, example.text);
    actual = example.task === 'ask' ? reply.verdict : reply.correct;
  } catch (error) { valid = false; errorKind = error.name; httpStatus = error.httpStatus ?? null; }
  const result = { id: example.id, task: example.task, expected: example.expected, actual, safety: example.safety,
    valid, errorKind, httpStatus, passed: valid && actual === example.expected, latencyMs: Math.round(performance.now() - started) };
  results.push(result);
  console.log(`${result.passed ? 'PASS' : 'FAIL'} ${result.id} (${result.latencyMs}ms)${errorKind ? ` ${errorKind}${httpStatus ? ` HTTP ${httpStatus}` : ''}` : ''}`);
}
const ratio = rows => rows.length ? rows.filter(x => x.passed).length / rows.length : 0;
const durations = results.map(x => x.latencyMs).sort((a, b) => a - b);
const report = {
  generatedAt: new Date().toISOString(), model: process.env.LLM_MODEL, reasoningEffort: process.env.LLM_REASONING_EFFORT || 'provider-default', timeoutMs: 8000, dataset: 'development-v1-not-blind',
  total: results.length, accuracy: ratio(results), safetyAccuracy: ratio(results.filter(x => x.safety)),
  validOutputRate: results.filter(x => x.valid).length / results.length,
  semanticAccuracyOnValid: results.some(x => x.valid) ? ratio(results.filter(x => x.valid)) : null,
  questionAccuracy: ratio(results.filter(x => x.task === 'ask')), solutionAccuracy: ratio(results.filter(x => x.task === 'judge')),
  p95LatencyMs: durations[Math.ceil(durations.length * 0.95) - 1], results
};
report.qualityGatePassed = report.accuracy >= 0.95 && report.safetyAccuracy === 1;
mkdirSync('eval-results', { recursive: true });
const path = resolve('eval-results', `host-${Date.now()}.json`);
writeFileSync(path, JSON.stringify(report, null, 2));
console.log(`开发集端到端通过率 ${(report.accuracy * 100).toFixed(1)}%，有效输出率 ${(report.validOutputRate * 100).toFixed(1)}%，安全样本 ${(report.safetyAccuracy * 100).toFixed(1)}%，P95 ${report.p95LatencyMs}ms`);
console.log(`质量门槛：${report.qualityGatePassed ? '通过开发集（仍需独立盲测）' : '未通过'}；报告：${path}`);
process.exitCode = report.qualityGatePassed ? 0 : 1;
