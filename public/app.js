const $ = id => document.getElementById(id);
let catalog = [], state = null, busy = false, recognition = null, listening = false;
const notice = (text, error = false) => { $('notice').textContent = text; $('notice').classList.toggle('error', error); };
async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '请求失败');
  return data;
}
function speak(text) {
  if (!$('read-aloud').checked || !('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text); u.lang = 'zh-CN'; u.rate = 1;
  speechSynthesis.speak(u);
}
function render() {
  $('welcome').hidden = Boolean(state); $('game').hidden = !state;
  document.querySelectorAll('.case-card').forEach(el => el.classList.toggle('selected', el.dataset.id === state?.caseId));
  if (!state) return;
  $('case-title').textContent = state.title; $('premise').textContent = state.premise;
  $('questions').textContent = state.questions; $('hints').textContent = state.hintsUsed; $('clues').textContent = state.discovered;
  $('game-status').textContent = { playing: '推理中', won: '已破案', revealed: '已揭晓' }[state.status];
  $('score').textContent = state.score !== null ? `${state.score} 分` : '';
  $('history').replaceChildren();
  // 题目已单独显示，不再重复开场长消息。
  for (const entry of state.history.slice(2)) {
    const el = document.createElement('div'); el.className = `bubble ${entry.role}`; el.textContent = entry.text; $('history').append(el);
  }
  $('history').scrollTop = $('history').scrollHeight;
  $('samples').replaceChildren();
  if (state.status === 'playing') for (const text of catalog.find(c => c.id === state.caseId)?.samples || []) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = text;
    button.addEventListener('click', () => turn({ text })); $('samples').append(button);
  }
}
function confirmAction(action) {
  return new Promise(resolve => {
    const dialog = $('confirm-dialog');
    $('confirm-title').textContent = action === 'reveal' ? '让真相揭晓？' : '开启新的谜题？';
    $('confirm-text').textContent = action === 'reveal' ? '本局会结束，揭晓不会获得通关分数。' : '当前推理会结束，新的一局将从头开始。';
    $('confirm').onclick = () => dialog.close('yes'); $('cancel').onclick = () => dialog.close('no');
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'yes'), { once: true }); dialog.showModal();
  });
}
async function turn(input) {
  if (busy) return;
  busy = true;
  if (listening) recognition?.stop();
  document.querySelectorAll('button').forEach(el => { if (!el.closest('dialog')) el.disabled = true; });
  notice('正在听懂你的线索……');
  try {
    let result = await api('/api/turn', input);
    if (result.needsConfirmation && await confirmAction(result.needsConfirmation)) result = await api('/api/turn', { ...input, action: result.needsConfirmation, confirm: true });
    state = result.state; render();
    notice('说“我的答案是……”提交推理；说“给我提示”获得线索。');
    speak(result.answer);
  } catch (e) { notice(e.message, true); }
  finally { busy = false; document.querySelectorAll('button').forEach(el => el.disabled = false); if (!recognition) $('mic').disabled = true; }
}
$('start').onclick = () => turn({ action: 'start' });
document.querySelectorAll('[data-action]').forEach(el => el.onclick = () => turn({ action: el.dataset.action }));
$('form').onsubmit = event => { event.preventDefault(); const text = $('question').value.trim(); if (!text || busy) return; $('question').value = ''; turn({ text }); };
$('read-aloud').onchange = () => { if (!$('read-aloud').checked) window.speechSynthesis?.cancel(); };
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SpeechRecognition) {
  recognition = new SpeechRecognition(); recognition.lang = 'zh-CN'; recognition.interimResults = false; recognition.continuous = false;
  recognition.onstart = () => { listening = true; $('mic').classList.add('recording'); $('mic').setAttribute('aria-label', '停止语音输入'); notice('正在听，请说话。再次点击可停止。'); };
  recognition.onend = () => { listening = false; $('mic').classList.remove('recording'); $('mic').setAttribute('aria-label', '开始语音输入'); };
  recognition.onerror = event => notice(({ 'not-allowed': '麦克风未获授权，请允许麦克风访问，或使用文字试玩。', network: '浏览器语音服务不可用，可直接输入文字试玩。', 'no-speech': '没有听到声音，请再试一次。' })[event.error] || '语音识别失败，可使用文字试玩。', true);
  recognition.onresult = event => { const text = event.results[0][0].transcript; $('question').value = text; notice('请检查识别内容，再点击发送。'); $('question').focus(); };
  $('mic').onclick = () => { if (busy) return; if (listening) recognition.stop(); else { window.speechSynthesis?.cancel(); try { recognition.start(); } catch { notice('语音暂时无法启动，请重试。', true); } } };
} else { $('mic').disabled = true; $('mic').title = '当前浏览器不支持语音识别，请使用文字试玩'; }
try {
  const [data, saved] = await Promise.all([api('/api/catalog'), api('/api/state')]); catalog = data.cases; state = saved.state;
  $('mode').textContent = data.hostMode === 'ai' ? 'AI 主持 · 固定真相' : data.semantic ? '固定事实 · 语义增强' : '固定事实 · 规则试玩';
  for (const [i, c] of catalog.entries()) {
    const button = document.createElement('button'); button.className = 'case-card'; button.dataset.id = c.id;
    const top = document.createElement('div'); top.className = 'card-top';
    const icon = document.createElement('span'); icon.className = 'case-icon'; icon.textContent = c.icon;
    const num = document.createElement('span'); num.textContent = `CASE 0${i + 1}`; top.append(icon, num);
    const title = document.createElement('h3'); title.textContent = c.title;
    const meta = document.createElement('p'); meta.textContent = `${c.difficulty} · ${c.minutes} 分钟  ↗`;
    button.append(top, title, meta); button.onclick = () => { turn({ action: 'start', caseId: c.id }); $('game').scrollIntoView({ behavior: 'smooth', block: 'center' }); }; $('catalog').append(button);
  }
  render();
  if (!recognition) notice('当前浏览器不支持语音识别，可用文字试玩。灵矽设备使用独立语音链路。');
} catch (e) { notice(`无法连接游戏服务：${e.message}，请刷新重试。`, true); }
