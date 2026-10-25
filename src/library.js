const normalize = value => String(value).replace(/[\s，。？！、,.?!：:《》“”‘’"']/g, '');
export function parseCaseSelection(text, library) {
  const value = normalize(text);
  const prefixes = ['确认切换到', '确认选择', '确认开始', '开始谜声游戏', '开始游戏', '切换到', '我想玩', '来一道', '来一题', '开始', '选择', '玩'];
  const prefix = prefixes.find(x => value.startsWith(x));
  if (!prefix) return null;
  const selected = value.slice(prefix.length);
  const c = library.find(c => normalize(c.title) === selected || normalize(c.title) + '吧' === selected);
  return c ? { caseId: c.id, confirmed: prefix.startsWith('确认') } : null;
}

export function playerCommand(text, library) {
  const selection = parseCaseSelection(text, library);
  if (selection) return { action: 'start', caseId: selection.caseId, confirm: selection.confirmed };
  const q = normalize(text);
  if (/^(开始|开始游戏|来一局|玩游戏|下一关|再来一局)$/.test(q)) return { action: 'start', confirm: false };
  if (/^(确认重开|确认开始新一局)$/.test(q)) return { action: 'start', confirm: true };
  if (/^(提示|给我提示|给点提示|来个提示)$/.test(q)) return { action: 'hint' };
  if (/^(重说|复述|再说一遍|重复题目|重听题目)$/.test(q)) return { action: 'repeat' };
  if (/^(回顾推理|回放推理|推理回放|复盘|回顾上一局|上一局回放|请用游戏工具回顾(本局|上一局)推理记录)$/.test(q)) return { action: 'replay' };
  if (/^(题库|有哪些题|有什么题|选题)$/.test(q)) return { action: 'list' };
  if (/^(揭晓|揭晓答案|告诉我答案|放弃)$/.test(q)) return { action: 'reveal', confirm: false };
  if (/^(确认揭晓|确认放弃)$/.test(q)) return { action: 'reveal', confirm: true };
  if (/^(我知道了|提交答案|我的答案|答案是)[：:]?/.test(String(text).trim())) return { action: 'solve' };
  return null;
}

export function reviewedQuestion(c, text) {
  const value = normalize(text);
  const checked = c.reviewedQuestions?.find(entry => entry.questions.some(q => normalize(q) === value));
  return checked ? { verdict: checked.verdict, evidenceIds: [...checked.evidenceIds] } : null;
}

export function hintPlan(c) {
  return c.hintPlan || c.hints.map((text, i) => ({ id: `hint-${i + 1}`, stage: ['换个角度', '缩小范围', '串起因果'][i] || '继续探索', text }));
}
export function nextHint(c, state) {
  const plan = hintPlan(c), used = new Set(state.hintIds || plan.slice(0, state.hints).map(h => h.id));
  return plan.find(h => {
    if (used.has(h.id)) return false;
    if (!h.skipWhen) return true;
    // 证据“被引用”不等于玩家知道了整条事实。只跳过明确肯定且提到对应主题的提示。
    return !(state.trace || []).some(e => e.kind === 'question' && e.verdict === 'yes'
      && e.evidenceIds?.includes(h.skipWhen.evidenceId) && h.skipWhen.terms.some(term => e.text.includes(term)));
  }) || null;
}

export function validateLibrary(library) {
  const errors = [], seenIds = new Set(), titles = new Set();
  if (!Array.isArray(library) || !library.length) return ['题库必须是非空数组'];
  for (const c of library) {
    const id = c?.id || '(缺少 id)';
    const fail = message => errors.push(`${id}: ${message}`);
    if (!c || typeof c !== 'object') { fail('题目必须为对象'); continue; }
    if (!/^[a-z][a-z0-9-]{1,63}$/.test(c.id || '') || seenIds.has(c.id)) fail('id 无效或重复');
    seenIds.add(c.id);
    if (typeof c.title !== 'string' || !c.title.trim() || titles.has(c.title)) fail('标题为空或重复'); titles.add(c.title);
    for (const key of ['premise', 'truth', 'difficulty']) if (typeof c[key] !== 'string' || !c[key].trim()) fail(`缺少 ${key}`);
    if (!Number.isFinite(c.minutes) || c.minutes < 1 || c.minutes > 30) fail('minutes 应为 1–30');
    if (!Array.isArray(c.hints) || c.hints.length !== 3 || c.hints.some(x => typeof x !== 'string' || !x.trim())) fail('需要三条递进提示');
    const factIds = new Set();
    if (!Array.isArray(c.facts) || c.facts.length < 2) fail('至少需要两条审核事实');
    for (const f of Array.isArray(c.facts) ? c.facts : []) {
      if (!f || typeof f !== 'object') { fail('事实必须是对象'); continue; }
      if (typeof f.id !== 'string' || !f.id || typeof f.text !== 'string' || !f.text || factIds.has(f.id)) fail('事实 id 重复或内容缺失'); factIds.add(f.id);
      if (![f.yes, f.no].every(x => Array.isArray(x) && x.every(term => typeof term === 'string' && term.trim()))) fail('事实规则别名必须是字符串数组');
    }
    const solutionIds = new Set();
    if (!Array.isArray(c.solution) || !c.solution.length) fail('需要独立评分规准');
    for (const s of Array.isArray(c.solution) ? c.solution : []) {
      if (!s || typeof s !== 'object') { fail('评分规准必须是对象'); continue; }
      if (typeof s.id !== 'string' || !s.id || typeof s.description !== 'string' || !s.description || solutionIds.has(s.id)) fail('评分规准缺失或 id 重复'); solutionIds.add(s.id);
    }
    if (!Array.isArray(c.samples) || c.samples.length < 2 || c.samples.some(x => typeof x !== 'string' || !x.trim())) fail('至少需要两个示例问题');
    if (!Array.isArray(c.concepts) || !c.concepts.length || c.concepts.some(group => !Array.isArray(group) || !group.length || group.some(x => typeof x !== 'string' || !x.trim()))) fail('需要离线备用判题的概念组');
    const reviewedTexts = new Set();
    if (c.reviewedQuestions && !Array.isArray(c.reviewedQuestions)) fail('标准问法必须为数组');
    for (const entry of Array.isArray(c.reviewedQuestions) ? c.reviewedQuestions : []) {
      if (!entry || !Array.isArray(entry.questions) || !entry.questions.length || !['yes', 'no', 'unknown'].includes(entry.verdict) || !Array.isArray(entry.evidenceIds)) { fail('标准问法格式错误'); continue; }
      if ((entry.verdict === 'unknown' && entry.evidenceIds.length) || (entry.verdict !== 'unknown' && !entry.evidenceIds.length) || entry.evidenceIds.some(id => !factIds.has(id) && !['premise', 'truth'].includes(id))) fail('标准问法证据无效');
      for (const q of entry.questions) {
        if (typeof q !== 'string' || !q.trim()) { fail('标准问题必须为非空字符串'); continue; }
        const key = normalize(q); if (reviewedTexts.has(key)) fail('标准问法重复或冲突'); reviewedTexts.add(key);
      }
    }
    if (c.hintPlan) {
      if (!Array.isArray(c.hintPlan) || c.hintPlan.length !== 3) fail('hintPlan 需要三个阶段');
      const ids = new Set();
      for (const [i, h] of (Array.isArray(c.hintPlan) ? c.hintPlan : []).entries()) {
        if (!h || typeof h !== 'object') { fail('提示阶段必须是对象'); continue; }
        if (typeof h.id !== 'string' || !h.id || ids.has(h.id) || typeof h.stage !== 'string' || !h.stage || typeof h.text !== 'string' || !h.text) fail('提示阶段缺失或 id 重复'); ids.add(h.id);
        if (h.text !== c.hints?.[i]) fail('提示列表和阶段文本不一致');
        if (h.skipWhen && (!factIds.has(h.skipWhen.evidenceId) || !Array.isArray(h.skipWhen.terms) || !h.skipWhen.terms.length || h.skipWhen.terms.some(x => typeof x !== 'string' || !x.trim()))) fail('跳过条件必须引用已审核事实与明确主题');
      }
    }
    if (c.featured && (!c.debrief?.illusion || !c.debrief?.mechanism || !c.debrief?.takeaway || (!Array.isArray(c.boundaries) || !c.boundaries.length || c.boundaries.some(x => typeof x !== 'string' || !x.trim())))) fail('精选题需要复盘说明与世界边界');
  }
  return errors;
}
