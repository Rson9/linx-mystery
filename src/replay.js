import { VERDICT_TEXT } from './host.js';

export const scoreFor = state => state.status === 'won'
  ? Math.max(0, 100 - state.hints * 15 - Math.max(0, state.questions - 5) * 2 - Math.max(0, state.attempts - 1) * 5) : null;
export function recordTrace(state, event) {
  state.trace ||= [];
  state.trace.push({ ...event, elapsedSeconds: state.startedAt ? Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000)) : null });
  if (state.trace.length > 100) { state.trace = state.trace.slice(-100); state.traceTruncated = true; }
}
function legacyTrace(state) {
  const result = [];
  for (let i = 0; i < state.history.length - 1; i++) {
    const user = state.history[i], reply = state.history[i + 1];
    if (user.role !== 'user' || reply.role !== 'assistant') continue;
    const verdict = Object.keys(VERDICT_TEXT).find(x => VERDICT_TEXT[x] === reply.text);
    if (verdict) result.push({ kind: 'question', text: user.text, verdict, elapsedSeconds: null });
    else if (/^提示\s*\d/.test(reply.text)) result.push({ kind: 'hint', text: reply.text, elapsedSeconds: null });
    else if (/^推理正确/.test(reply.text)) result.push({ kind: 'answer', text: user.text, correct: true, elapsedSeconds: null });
    else if (/^可以确认/.test(reply.text)) result.push({ kind: 'question', text: user.text, verdict: 'fact', answer: reply.text, elapsedSeconds: null });
  }
  return result;
}
export function buildReplay(state, c) {
  if (!['won', 'revealed'].includes(state.status)) return null;
  const trace = state.trace?.length ? state.trace : legacyTrace(state);
  const steps = trace.filter(e => ['question', 'hint', 'answer'].includes(e.kind)).slice(-12).map(e => {
    if (e.kind === 'question') return { kind: 'question', label: e.verdict === 'yes' ? '确认方向' : e.verdict === 'no' ? '排除假设' : e.verdict === 'unknown' ? '保留未知' : '澄清边界',
      text: e.text, answer: VERDICT_TEXT[e.verdict] || e.answer || '未形成确定结论', source: e.source || 'unlabelled', elapsedSeconds: e.elapsedSeconds };
    if (e.kind === 'hint') return { kind: 'hint', label: `使用提示${e.stage ? ` · ${e.stage}` : ''}`, text: e.text, elapsedSeconds: e.elapsedSeconds };
    return { kind: 'answer', label: e.correct ? '串起因果' : '尝试解释', text: e.text, correct: Boolean(e.correct), source: e.source || 'unlabelled', elapsedSeconds: e.elapsedSeconds };
  });
  const confirmed = steps.filter(e => e.kind === 'question' && ['是的。', '不是。'].includes(e.answer));
  const elapsedSeconds = state.startedAt && state.finishedAt ? Math.max(0, Math.floor((state.finishedAt - state.startedAt) / 1000)) : null;
  return {
    gameId: state.id, caseId: c.id, title: c.title, status: state.status, score: scoreFor(state), elapsedSeconds,
    questions: state.questions, hintsUsed: state.hints, attempts: state.attempts,
    summary: state.status === 'won' ? `你用 ${state.questions} 个计分问题、${state.hints} 个提示，把线索连成了答案。` : `你选择揭晓，本局不计通关分数。可以看看哪些问题帮助你接近了真相。`,
    steps, turningPoint: confirmed.length ? confirmed.at(-1) : null,
    truncated: Boolean(state.traceTruncated || trace.length > 12), provenance: state.trace?.length ? 'recorded-events' : 'legacy-history',
    truth: c.truth,
    debrief: c.debrief || { illusion: '题面里看似矛盾的日常，需要换一个观察角度。', mechanism: c.truth, takeaway: '把已确认的事实连成因果，而不是只罗列关键词。' }
  };
}
export function replaySpeech(replay) {
  const point = replay.turningPoint;
  const quote = point ? `你问过“${point.text.slice(0, 36)}”，当时回答是“${point.answer}”。` : '这局没有记录到确定的真假结论。';
  return `《${replay.title}》回顾：${replay.summary}${quote}${replay.debrief.takeaway}`;
}
// 本机桥只转发这个白名单，不将内部 trace、证据或评分规准传给页面。
export function projectReplay(value) {
  if (!value || !['won', 'revealed'].includes(value.status)) return null;
  const result = {};
  for (const key of ['gameId', 'caseId', 'title', 'status', 'score', 'elapsedSeconds', 'questions', 'hintsUsed', 'attempts', 'summary', 'truth', 'truncated', 'provenance']) result[key] = value[key];
  const projectStep = e => Object.fromEntries(['kind', 'label', 'text', 'answer', 'correct', 'source', 'elapsedSeconds'].filter(k => k in e).map(k => [k, e[k]]));
  result.steps = (Array.isArray(value.steps) ? value.steps : []).slice(-12).filter(x => x && typeof x === 'object').map(projectStep);
  result.turningPoint = value.turningPoint && typeof value.turningPoint === 'object' ? projectStep(value.turningPoint) : null;
  result.debrief = Object.fromEntries(['illusion', 'mechanism', 'takeaway'].map(k => [k, String(value.debrief?.[k] || '')]));
  return result;
}
