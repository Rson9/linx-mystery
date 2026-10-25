import { PetAudio } from './audio.js';
import { saveCaseCard } from './share.js';
const $ = id => document.getElementById(id);
const isLocal = ['127.0.0.1', 'localhost'].includes(location.hostname) && !location.pathname.startsWith('/pet/');
let ws, ready = false, connecting = false, recording = false, micBusy = false, speaking = false, pairing = false;
let epoch = 0, responseEpoch = 0, game = null, currentReply = null, inputMode = 'ask', muted = false, lastWon = null;
let lastError = '', manualClose = false, awaiting = false, pendingEcho = null;
let library = [], libraryLoading = true, selectedCase = null, viewingReplay = null, archivedReplay = null;
let slowTimer, responseTimer, requestRevision = -1, requestGameId = null;
const normalized = text => String(text).replace(/[\s，。？！、,.?!：:“”‘’"']/g, '');
const audio = new PetAudio(level => document.documentElement.style.setProperty('--level', Math.min(1, level * 8)));
const moodNames = { sleeping: '正在打盹', idle: '等你提问', listening: '认真听着', thinking: '努力想一想', speaking: '正在回答', celebrate: '破案啦！', error: '需要你帮一下' };
function mood(value) { $('pet-device').dataset.mood = value; $('mood-label').textContent = moodNames[value]; }
function bubble(text, source = '设备提示') { $('speech-text').textContent = text; $('speech-source').textContent = source; }
function notice(text, error = false) { $('notice').textContent = text; $('notice').classList.toggle('error', error); }
function connection(text, online = false) { $('connection').lastElementChild.textContent = text; $('connection').classList.toggle('online', online); $('radio-state').textContent = text; }
function controls() {
  const busy = connecting || micBusy || recording || awaiting;
  $('wake').disabled = !isLocal || libraryLoading || connecting || micBusy || recording;
  $('wake').firstChild.textContent = connecting ? '正在唤醒… ' : ready ? '让小矽休眠 ' : '唤醒并开始 ';
  $('mic').disabled = !ready || !game || micBusy; $('mic').classList.toggle('recording', recording);
  $('mic').setAttribute('aria-label', recording ? '结束说话' : '开始说话');
  $('mic-label').textContent = micBusy ? '请稍等…' : recording ? '说完点这里' : ready && !game ? '等待开局…' : '点击说话';
  $('interrupt').disabled = !ready;
  for (const id of ['hint', 'coach-hint', 'repeat', 'send']) $(id).disabled = !ready || busy || speaking;
  $('next').disabled = !ready || busy;
  if (!game) for (const id of ['hint', 'coach-hint', 'repeat', 'next']) $(id).disabled = true;
  if (game?.hintsAvailable === false) { $('hint').disabled = true; $('coach-hint').disabled = true; }
  $('library-launcher').disabled = libraryLoading || !library.length;
  for (const card of document.querySelectorAll('.story-card')) card.disabled = busy;
  for (const button of document.querySelectorAll('.starter-question')) button.disabled = !ready || busy || speaking;
  $('start-game').disabled = !isLocal || libraryLoading || busy || (speaking && !game);
  $('start-game').textContent = game?.status === 'playing' ? '换一道题 ↗' : '开始这题 ↗';
  $('reveal').disabled = !ready || busy || speaking || game?.status !== 'playing';
  $('voice-help').textContent = recording ? '麦克风已开启 · 再点一次发送 · 最长 45 秒' : ready && !game ? '正在确认游戏开局，确认后才能开启麦克风' : ready && speaking ? '正在播报 · 可点 ■ 打断，或直接点击说话' : ready ? '说完再点一次发送 · 作答时先说“我的答案是”' : '语音由灵矽提供 · 点击后才会打开麦克风';
}
function waiting(value) {
  awaiting = value; clearTimeout(slowTimer); clearTimeout(responseTimer);
  if (!value) return;
  requestRevision = game?.revision ?? -1; requestGameId = game?.gameId ?? null;
  slowTimer = setTimeout(() => { if (awaiting) notice('小矽还在确认。可以点 ■ 打断，不会自动重发或重复扣分。'); }, 12000);
  responseTimer = setTimeout(() => {
    if (!awaiting || !ready || ws?.readyState !== WebSocket.OPEN) return;
    const changed = game && (game.gameId !== requestGameId || game.revision > requestRevision);
    const answer = changed && game.history.filter(x => x.role === 'assistant').at(-1)?.text;
    waiting(false); stopPlayback(); send({ type: 'abort' }); mood('idle'); controls();
    if (answer) {
      bubble(answer, '已同步的游戏记录 · 文字备用'); addMessage('assistant', answer, '小矽 · 游戏记录');
      notice('语音等候超时，已展示服务端确认的文字回复。没有重新执行本次操作。', true);
    } else notice('暂未收到可确认的回复，已停止等待，没有自动重试。可先“重听故事”确认状态。重新连接会开启新会话。', true);
  }, 35000);
}
function addMessage(role, text, label) {
  const log = $('conversation'), atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 50;
  log.querySelector('.empty')?.remove();
  const item = document.createElement('div'); item.className = `message ${role}`;
  const caption = document.createElement('small'); caption.textContent = label;
  const content = document.createElement('span'); content.textContent = text;
  item.append(caption, content); log.append(item);
  while (log.children.length > 60) log.firstElementChild.remove();
  if (atBottom) log.scrollTop = log.scrollHeight;
  return content;
}
function renderLibrary() {
  $('library-list').replaceChildren();
  $('library-status').textContent = `${library.length} 个故事 · ${library.filter(c => c.featured).length} 道自编新题 · 按题名也能语音选题`;
  for (const c of [...library].sort((a, b) => Number(b.featured) - Number(a.featured))) {
    const card = document.createElement('button'); card.type = 'button'; card.className = 'story-card'; card.dataset.caseId = c.id;
    card.classList.toggle('selected', c.id === selectedCase?.id); card.setAttribute('aria-pressed', String(c.id === selectedCase?.id));
    const tag = document.createElement('span'); tag.className = 'story-tag'; tag.textContent = `${c.collection} / ${c.theme}`;
    const title = document.createElement('b'); title.textContent = `${c.icon} ${c.title}`;
    const blurb = document.createElement('span'); blurb.textContent = c.blurb;
    const meta = document.createElement('small'); meta.textContent = `${c.difficulty} · 约 ${c.minutes} 分钟${c.featured && c.difficulty === '暖场' ? ' · 推荐第一局' : ''}`;
    card.append(tag, title, blurb, meta); card.onclick = () => void chooseCase(c); $('library-list').append(card);
  }
  controls();
}
function availableReplay() {
  if (game?.replay) return game.replay;
  const previous = game?.previousRound || archivedReplay;
  return previous && previous.caseId !== (game?.caseId || selectedCase?.id) ? previous : null;
}
function previewCase() {
  if (game || !selectedCase) return;
  $('case-status').textContent = '准备开局'; $('questions').textContent = '0'; $('hints').textContent = '0'; $('score').textContent = '—';
  $('result').hidden = true; $('result-title').textContent = ''; $('coach').hidden = true;
  $('clue-count').textContent = '0 条'; $('clues').replaceChildren();
  const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = '好问题，是通往真相的第一步。'; $('clues').append(empty);
  $('open-replay').hidden = !availableReplay(); $('open-replay').textContent = '↺ 上一局 · 推理回放';
  $('case-title').textContent = selectedCase.title; $('premise').textContent = selectedCase.premise;
  $('case-number').textContent = `${selectedCase.collection} / 待开局`;
  $('compact-game').hidden = false; $('compact-title').textContent = selectedCase.title;
  $('compact-stats').textContent = `待开局 · 约 ${selectedCase.minutes} 分钟`;
  renderStarters();
}
function renderStarters() {
  $('ask-starters').replaceChildren();
  const c = library.find(c => c.id === game?.caseId) || selectedCase;
  for (const text of (c?.samples || []).slice(0, 2)) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'starter-question'; button.textContent = text;
    button.onclick = () => void sendText(text, '你 · 提问起点'); $('ask-starters').append(button);
  }
}
async function chooseCase(c) {
  if (connecting || recording || micBusy || awaiting) return;
  $('library-dialog').close();
  if (ready && game?.status === 'playing') {
    if (game.caseId === c.id) { notice('正在推理这个故事，继续问吧。'); return; }
    if (!await confirmAction(`换到《${c.title}》？`, '当前推理还没有结束。确认后会放弃本题；仅浏览题库不会换题。')) return;
  }
  selectedCase = c; localStorage.setItem('pet-selected-case', c.id); renderLibrary();
  if (ready) await freshCase(c);
  else { game = null; previewCase(); bubble(`选好了《${c.title}》。唤醒我，就从这个故事开始。`); notice(isLocal ? '还没有开启麦克风。点“唤醒并开始”听故事。' : '外观预览。真实游玩请在本机运行 pnpm pet。'); }
}
async function freshCase(c) {
  // 每局独立连接，避免上一题的谜底、长上下文和工具循环干扰新局。旧回放只读留在本页。
  archivedReplay = game?.replay || game?.previousRound || archivedReplay;
  await disconnect(false); game = null; selectedCase = c;
  localStorage.setItem('pet-selected-case', c.id);
  inputMode = 'ask'; $('ask-mode').classList.add('selected'); $('answer-mode').classList.remove('selected'); $('text').value = '';
  $('text').placeholder = '每次只问一件能回答是或不是的事…';
  $('conversation').replaceChildren(); renderLibrary(); previewCase(); await wake();
}
function showGame(view) {
  if (!view.state) return;
  const changedGame = game?.gameId !== view.state.gameId;
  game = view.state;
  if (changedGame) { selectedCase = library.find(c => c.id === game.caseId) || selectedCase; renderLibrary(); renderStarters(); }
  $('case-title').textContent = game.title; $('premise').textContent = game.premise;
  $('case-number').textContent = `${game.collection || 'CASE FILE'} / ${game.status === 'playing' ? '当前谜题' : '本局记录'}`;
  $('case-status').textContent = ({ playing: '正在推理', won: '已破案', revealed: '已揭晓' })[game.status] || '准备开局';
  $('questions').textContent = game.questions; $('hints').textContent = game.hintsUsed;
  $('score').textContent = Number.isFinite(game.score) ? game.score : '—';
  $('compact-game').hidden = false; $('compact-title').textContent = game.title;
  $('compact-stats').textContent = game.status === 'won' ? `破案 · ${game.score} 分` : `提问 ${game.questions} · 提示 ${game.hintsUsed}`;
  const clues = [];
  for (let i = 0; i < game.history.length - 1; i++) {
    const a = game.history[i], b = game.history[i + 1];
    if (a.role === 'user' && b.role === 'assistant' && ['是的。', '不是。'].includes(b.text)) clues.push({ text: a.text, yes: b.text === '是的。' });
  }
  $('clue-count').textContent = `${clues.length} 条`; $('clues').replaceChildren();
  if (!clues.length) { const p = document.createElement('p'); p.className = 'empty'; p.textContent = '好问题，是通往真相的第一步。'; $('clues').append(p); }
  for (const clue of clues.slice(-5)) {
    const row = document.createElement('div'); row.className = `clue ${clue.yes ? 'yes' : 'no'}`;
    const icon = document.createElement('span'); icon.textContent = clue.yes ? '✓ 是' : '× 否';
    const text = document.createElement('p'); text.textContent = clue.text; row.append(icon, text); $('clues').append(row);
  }
  $('coach').hidden = !game.nudge;
  if (game.nudge) { $('coach-title').textContent = game.nudge.title; $('coach-text').textContent = game.nudge.text; }
  $('result').hidden = game.status === 'playing';
  $('open-replay').hidden = !availableReplay();
  $('open-replay').textContent = game.replay ? '↺ 回看这一局 · 推理回放' : '↺ 上一局 · 推理回放';
  $('result-replay').hidden = !game.replay;
  if (game.status !== 'playing') {
    $('result-title').textContent = game.status === 'won' ? `破案成功 · ${game.score} 分` : '真相已经揭晓';
    $('result-text').textContent = game.status === 'won' ? `用了 ${game.questions} 个计分问题、${game.hintsUsed} 个提示。回看你的推理，而不只是分数。` : '这一局不计通关分数，也可以回看线索。';
    if (game.status === 'won' && lastWon !== game.gameId) {
      lastWon = game.gameId;
      if (!recording && !speaking) { mood('celebrate'); setTimeout(() => { if (ready && !recording && !speaking) mood('idle'); }, 2200); }
    }
  }
  if (view.judging && !recording && !speaking) mood('thinking');
  controls();
}
const duration = seconds => Number.isFinite(seconds) ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : '未记录';
function openReplay() {
  const replay = availableReplay();
  if (!replay) return;
  viewingReplay = replay; $('replay-title').textContent = `《${replay.title}》· 推理回放`; $('replay-summary').textContent = replay.summary;
  $('replay-metrics').replaceChildren();
  for (const [label, value] of [['计分提问', replay.questions], ['提示', replay.hintsUsed], ['作答', replay.attempts], ['用时', duration(replay.elapsedSeconds)], ['得分', replay.score ?? '不计分']]) {
    const metric = document.createElement('span'), b = document.createElement('b'), small = document.createElement('small');
    b.textContent = value; small.textContent = label; metric.append(b, small); $('replay-metrics').append(metric);
  }
  $('replay-illusion').textContent = replay.debrief.illusion; $('replay-truth').textContent = replay.truth; $('replay-takeaway').textContent = replay.debrief.takeaway;
  $('replay-steps').replaceChildren();
  for (const step of replay.steps) {
    const row = document.createElement('li'); row.dataset.kind = step.kind;
    const label = document.createElement('small'); label.textContent = `${step.label}${step.source === 'standard-question' ? ' · 内置核对' : ['agent-judgment', 'ai-host'].includes(step.source) ? ' · 语义判断' : ''}${Number.isFinite(step.elapsedSeconds) ? ` · ${duration(step.elapsedSeconds)}` : ''}`;
    const text = document.createElement('p'); text.textContent = step.text; row.append(label, text);
    if (step.answer) { const answer = document.createElement('b'); answer.textContent = step.answer; row.append(answer); }
    if (step.kind === 'answer') { const status = document.createElement('b'); status.textContent = step.correct ? '✓ 推理正确' : '还没完整解释'; row.append(status); }
    $('replay-steps').append(row);
  }
  $('replay-note').textContent = `${replay.truncated ? '仅展示最近的推理片段。' : ''}回放仅展示实际记录的提问、判词、提示和作答。`;
  $('replay-share').hidden = replay.status !== 'won';
  $('replay-next').textContent = game?.status === 'playing' ? '回到当前推理 →' : '再来一个故事 →';
  $('replay-dialog').showModal(); $('replay-dialog').scrollTop = 0; controls();
}
async function confirmAction(title, description) {
  const dialog = $('confirm-dialog'); $('confirm-title').textContent = title; $('confirm-description').textContent = description;
  return new Promise(resolve => {
    dialog.returnValue = ''; $('cancel').onclick = () => dialog.close('no'); $('confirm-yes').onclick = () => dialog.close('yes');
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'yes'), { once: true }); dialog.showModal();
  });
}
function send(value) { if (ws?.readyState !== WebSocket.OPEN) throw new Error('小矽还没有连接，请先唤醒。'); ws.send(JSON.stringify(value)); }
function stopPlayback() { responseEpoch++; audio.silence(); speaking = false; currentReply = null; controls(); }
async function sendText(text, label = '你 · 文字') {
  if (!ready || recording || micBusy || awaiting || speaking) return;
  waiting(true); pendingEcho = normalized(text); controls();
  try {
    await audio.resume(); if (!ready) { waiting(false); controls(); return; }
    stopPlayback(); send({ type: 'say', text }); addMessage('user', text, label);
    mood('thinking'); bubble('收到啦，我在认真想你的问题。'); notice('问题已发送，小矽正在确认。');
  } catch (error) { waiting(false); controls(); notice(error.message, true); }
}
async function disconnect(sleep = true) {
  manualClose = true; epoch++; ready = false; connecting = false; recording = false; waiting(false); pendingEcho = null;
  ws?.close(); stopPlayback(); await audio.close(); controls();
  connection(sleep ? '等待唤醒' : '连接已断开'); mood(sleep ? 'sleeping' : 'error');
  if (sleep) bubble('我先眯一会儿。下次唤醒会开启新的语音会话；这一页还能回看刚才的记录。');
}
async function wake() {
  if (connecting || !isLocal || libraryLoading) return;
  if (ready) return disconnect();
  const currentEpoch = ++epoch;
  connecting = true; manualClose = false; pairing = false; lastError = '';
  controls(); connection('正在连接'); mood('thinking'); bubble('醒来啦，正在接通灵矽。');
  try {
    await audio.resume();
    const res = await fetch('./api/session', { method: 'POST' });
    if (!res.ok) throw new Error('本机终端没有准备好，请运行 pnpm pet。');
    const url = new URL('./voice', location.href); url.protocol = 'ws:';
    ws = new WebSocket(url); ws.binaryType = 'arraybuffer';
    ws.onmessage = async event => {
      if (currentEpoch !== epoch) return;
      if (event.data instanceof ArrayBuffer) {
        if (!recording && !micBusy) {
          try { audio.play(event.data); } catch (e) { stopPlayback(); notice(e.message, true); send({ type: 'abort' }); }
        }
        return;
      }
      let msg; try { msg = JSON.parse(event.data); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'ready') {
        ready = true; connecting = false; connection('灵矽已连接', true); mood('idle'); controls();
        notice('已连接。开局后点击说话，首次使用需允许麦克风权限。');
        void sendText(selectedCase ? `开始谜声游戏《${selectedCase.title}》` : '开始游戏', '你 · 开局按钮');
      } else if (msg.type === 'activation') {
        pairing = true; connecting = false; controls(); mood('error');
        $('activation-code').textContent = msg.code || '请重新获取'; $('activation').showModal(); connection('等待绑定');
      } else if (msg.type === 'error') {
        lastError = msg.message; notice(msg.message, true); bubble(msg.message); mood('error');
      } else if (msg.type === 'note') notice(msg.message, true);
      else if (msg.type === 'game') showGame(msg);
      else if (msg.type === 'stt') {
        if (pendingEcho === normalized(msg.text)) pendingEcho = null;
        else addMessage('user', msg.text, '你 · 语音识别');
        mood('thinking'); bubble('我听到啦，正在确认。');
      } else if (msg.type === 'record_limit') { await stopRecord(false); notice('本次录音达到 45 秒，已自动发送并关闭麦克风。'); }
      else if (msg.type === 'tts') {
        if (msg.is_aborted) { stopPlayback(); if (ready && !recording) mood('idle'); }
        else if (msg.state === 'start') { speaking = true; waiting(false); controls(); currentReply = null; mood('speaking'); }
        else if (msg.state === 'sentence_start' && msg.text) {
          speaking = true; mood('speaking'); bubble(msg.text, '灵矽正在播报');
          if (!currentReply) currentReply = addMessage('assistant', msg.text, '小矽 · 灵矽播报');
          else { currentReply.textContent += msg.text; $('conversation').scrollTop = $('conversation').scrollHeight; }
        } else if (msg.state === 'stop') {
          const response = responseEpoch; await audio.finished();
          if (currentEpoch === epoch && response === responseEpoch && ready && !recording) {
            speaking = false; controls(); mood(game?.status === 'won' ? 'celebrate' : 'idle'); $('speech-source').textContent = '上一句 · 灵矽播报';
            if (!$('notice').classList.contains('error')) notice(!game ? '等待游戏开局确认。' : game.status === 'won' ? '推理完成。回看这一局，或开始下一个故事。' : game.status === 'revealed' ? '真相已揭晓。可以查看回放或开始下一题。' : '轮到你了。问一个问题，或说“我的答案是……”。');
          }
        }
      }
    };
    ws.onerror = () => { if (currentEpoch === epoch) { lastError ||= '连接失败。请确认 pnpm pet 正在运行，其他桌宠窗口已关闭。'; notice(lastError, true); } };
    ws.onclose = () => {
      if (currentEpoch !== epoch) return;
      ready = false; connecting = false; recording = false; waiting(false); stopPlayback(); void audio.close(); controls();
      if (!pairing && !manualClose) { connection('需要重新唤醒'); mood('error'); notice(lastError || '会话已结束。重新唤醒会开启新会话；先记下当前线索。', true); }
    };
  } catch (error) { connecting = false; ready = false; controls(); connection('尚未连接'); mood('error'); notice(error.message, true); }
}
async function startRecord() {
  if (!ready || !game || recording || micBusy) return;
  micBusy = true; controls(); const currentEpoch = epoch;
  try {
    waiting(false); pendingEcho = null; stopPlayback(); send({ type: 'abort' });
    await audio.startCapture(frame => { if (ready && recording && currentEpoch === epoch && ws.readyState === WebSocket.OPEN) ws.send(frame); });
    if (!ready || currentEpoch !== epoch) { await audio.stopCapture(); return; }
    send({ type: 'record', state: 'start' }); recording = true; mood('listening'); bubble('我在听。说完再点一次，把这句话交给我。');
    notice('麦克风正在采集；音频只发送给灵矽，不在本地保存。');
  } catch (error) {
    await audio.stopCapture(); recording = false; mood('idle');
    if (error.name === 'NotAllowedError') { document.body.classList.remove('compact'); localStorage.setItem('pet-compact', '0'); window.dispatchEvent(new Event('pet:show-board')); $('text').focus(); }
    notice(error.name === 'NotAllowedError' ? `麦克风未获授权，已展开文字模式。${window.mishengDesktop ? '请在系统设置中允许谜声使用麦克风。' : '允许浏览器访问后可重试。'}` : error.message, true);
  } finally { micBusy = false; controls(); }
}
async function stopRecord(sendStop = true) {
  if (!recording || micBusy) return;
  micBusy = true; controls();
  try { await audio.stopCapture(); if (ready && sendStop) send({ type: 'record', state: 'stop' }); }
  finally { recording = false; micBusy = false; waiting(ready); controls(); if (ready) { mood('thinking'); bubble('听完啦，正在想答案。'); notice('麦克风已关闭，等待灵矽回答。'); } }
}
$('wake').onclick = () => void wake();
$('mic').onclick = () => void (recording ? stopRecord() : startRecord());
$('interrupt').onclick = () => { if (!ready) return; waiting(false); controls(); stopPlayback(); send({ type: 'abort' }); mood('idle'); bubble('暂停了。你可以继续问，也可以重听故事。'); notice('已打断当前回复，可以继续提问。'); };
$('hint').onclick = $('coach-hint').onclick = () => void sendText('给我提示', '你 · 提示按钮');
$('repeat').onclick = () => void sendText('重听题目', '你 · 重听按钮');
$('library-launcher').onclick = () => { $('library-dialog').showModal(); controls(); };
$('library-close').onclick = () => $('library-dialog').close();
$('open-replay').onclick = $('result-replay').onclick = openReplay;
$('replay-close').onclick = () => $('replay-dialog').close();
$('replay-share').onclick = async () => {
  if (!viewingReplay || viewingReplay.status !== 'won') return;
  $('replay-share').disabled = true;
  try { await saveCaseCard(viewingReplay, document.querySelector('#pet-touch canvas') || document.querySelector('#pet-touch svg')); $('replay-note').textContent = '已生成无剧透破案卡：仅包含题名和结算数据，不含谜底、问题原文、录音或玩家身份；没有上传服务器。'; }
  catch (error) { $('replay-note').textContent = error.message; }
  finally { $('replay-share').disabled = false; }
};
$('replay-next').onclick = () => { $('replay-dialog').close(); if (game?.status !== 'playing') $('next').click(); };
$('next').onclick = async () => {
  if (!ready || recording || micBusy || awaiting || !library.length) return;
  if (game?.status === 'playing' && !await confirmAction('先换一道题？', '当前推理还没结束。确认后会放弃本题，开启下一题。')) return;
  const index = library.findIndex(c => c.id === game?.caseId);
  await freshCase(library[(index + 1) % library.length]);
};
$('start-game').onclick = async () => {
  if (!ready) return wake();
  if (game?.status === 'playing') return $('library-launcher').click();
  if (game && selectedCase) await freshCase(selectedCase);
  else await sendText(selectedCase ? `开始谜声游戏《${selectedCase.title}》` : '开始游戏', '你 · 开局按钮');
};
$('reveal').onclick = async () => { if (await confirmAction('让真相揭晓？', '揭晓会结束本局，不获得通关分数。确定不再推理了吗？')) await sendText('确认揭晓', '你 · 已确认揭晓'); };
$('activation-close').onclick = () => $('activation').close();
$('mute').onclick = () => { muted = !muted; audio.setMuted(muted); $('mute').setAttribute('aria-pressed', String(muted)); $('mute').setAttribute('aria-label', muted ? '取消静音' : '静音'); $('mute').textContent = muted ? '♩' : '♫'; };
const setMode = value => { inputMode = value; $('ask-mode').classList.toggle('selected', value === 'ask'); $('answer-mode').classList.toggle('selected', value === 'answer'); $('text').placeholder = value === 'answer' ? '把完整的原因和实现方式说出来…' : '每次只问一件能回答是或不是的事…'; $('text').focus(); };
$('ask-mode').onclick = () => setMode('ask'); $('answer-mode').onclick = () => setMode('answer');
$('text-form').onsubmit = event => {
  event.preventDefault(); const text = $('text').value.trim(); if (!text || !ready || recording || micBusy || awaiting || speaking) return;
  $('text').value = ''; void sendText(inputMode === 'answer' && !/^(我的答案|提交答案|答案是)/.test(text) ? `我的答案是${text}` : text);
};
$('show-board').onclick = () => { document.body.classList.remove('compact'); localStorage.setItem('pet-compact', '0'); document.querySelector('.play-panel').scrollIntoView({ behavior: 'smooth', block: 'start' }); };
$('compact').onclick = () => { document.body.classList.toggle('compact'); localStorage.setItem('pet-compact', document.body.classList.contains('compact') ? '1' : '0'); };
if (new URL(location.href).searchParams.get('compact') === '1' || localStorage.getItem('pet-compact') === '1') document.body.classList.add('compact');
$('pet-touch').onclick = () => { if (!recording && !speaking && !connecting) { mood(ready ? 'celebrate' : 'idle'); bubble('摸摸已收到。准备好问一个好问题了吗？', '桌宠动作'); setTimeout(() => { if (!recording && !speaking && !connecting) mood(ready ? 'idle' : 'sleeping'); }, 1600); } };
window.addEventListener('pagehide', () => { waiting(false); ws?.close(); void audio.close(); });
if (window.mishengDesktop || new URL(location.href).searchParams.get('desktop') === '1') {
  const { mountDesktop } = await import('./desktop.js'); await mountDesktop();
}
controls();
try {
  const response = await fetch(isLocal ? './api/library' : '../api/catalog');
  if (!response.ok) throw new Error('题库暂时无法加载，请确认已运行最新版 pnpm pet。');
  const data = await response.json(); if (!Array.isArray(data.cases)) throw new Error('题库格式异常');
  library = data.cases;
  const requested = new URL(location.href).searchParams.get('case') || localStorage.getItem('pet-selected-case');
  selectedCase = library.find(c => c.id === requested) || library.find(c => c.featured) || library[0];
  renderLibrary(); previewCase();
} catch (error) { notice(error.message, true); }
finally { libraryLoading = false; controls(); }
if (!isLocal) {
  notice('当前为网页预览。语音游戏请在本机启动 pnpm pet，再打开 http://127.0.0.1:3212。', true);
  const link = document.createElement('a'); link.href = 'http://127.0.0.1:3212/'; link.textContent = ' 打开本机小矽 ↗'; $('notice').append(link);
  connection('外观预览'); bubble('真实的我住在你的电脑上。运行 pnpm pet，就能一起说话啦。');
} else {
  try {
    const r = await fetch('./api/config'); if (!r.ok) throw new Error('本机桌宠服务未启动，请运行 pnpm pet。');
    const config = await r.json();
    if (!config.engineOnline) notice('游戏服务未启动。运行 pnpm pet 会自动检查并启动本机服务。', true);
  } catch (error) { notice(error.message, true); }
}
