import { PetAudio } from './audio.js';
const $ = id => document.getElementById(id);
const isLocal = ['127.0.0.1', 'localhost'].includes(location.hostname);
let ws, ready = false, connecting = false, recording = false, micBusy = false, speaking = false, pairing = false;
let epoch = 0, responseEpoch = 0, game = null, currentReply = null, inputMode = 'ask', muted = false, lastWon = null;
let lastError = '', manualClose = false, autoStart = false, awaiting = false, pendingEcho = null;
const normalized = text => String(text).replace(/[\s，。？！、,.?!：:“”‘’"']/g, '');
const audio = new PetAudio(level => document.documentElement.style.setProperty('--level', Math.min(1, level * 8)));
const moodNames = { sleeping: '正在打盹', idle: '等你提问', listening: '认真听着', thinking: '努力想一想', speaking: '正在回答', celebrate: '破案啦！', error: '需要你帮一下' };
function mood(value) { $('pet-device').dataset.mood = value; $('mood-label').textContent = moodNames[value]; }
function bubble(text, source = '设备提示') { $('speech-text').textContent = text; $('speech-source').textContent = source; }
function notice(text, error = false) { $('notice').textContent = text; $('notice').classList.toggle('error', error); }
function connection(text, online = false) { $('connection').lastElementChild.textContent = text; $('connection').classList.toggle('online', online); $('radio-state').textContent = text; }
function controls() {
  $('wake').disabled = !isLocal || connecting || micBusy || recording;
  $('wake').firstChild.textContent = connecting ? '正在唤醒… ' : ready ? '让小矽休眠 ' : '唤醒并开始 ';
  $('mic').disabled = !ready || micBusy; $('mic').classList.toggle('recording', recording);
  $('mic').setAttribute('aria-label', recording ? '结束说话' : '开始说话');
  $('mic-label').textContent = micBusy ? '请稍等…' : recording ? '说完点这里' : '点击说话';
  $('interrupt').disabled = !ready;
  for (const id of ['hint', 'repeat', 'next', 'send']) $(id).disabled = !ready || recording || micBusy || awaiting;
  $('start-game').disabled = !isLocal || connecting || recording || micBusy || awaiting;
  $('start-game').textContent = game?.status === 'playing' ? '换一道题 ↗' : '开始游戏 ↗';
  $('reveal').disabled = !ready || recording || micBusy || awaiting || game?.status !== 'playing';
  $('voice-help').textContent = recording ? '麦克风已开启 · 再点一次发送 · 最长 45 秒' : ready ? '说完再点一次发送 · 作答时先说“我的答案是”' : '语音由灵矽提供 · 点击后才会打开麦克风';
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
function showGame(view) {
  if (!view.state) return;
  game = view.state;
  $('case-title').textContent = game.title; $('premise').textContent = game.premise;
  $('case-number').textContent = game.status === 'playing' ? 'CASE FILE / 当前谜题' : 'CASE CLOSED / 本局记录';
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
  $('result').hidden = game.status === 'playing';
  if (game.status !== 'playing') {
    $('result-title').textContent = game.status === 'won' ? `破案成功 · ${game.score} 分` : '真相已经揭晓';
    $('result-text').textContent = game.status === 'won' ? `用了 ${game.questions} 个有效问题、${game.hintsUsed} 个提示。再来一题吗？` : '这一局不计通关分数，下一题再挑战。';
    if (game.status === 'won' && lastWon !== game.gameId) {
      lastWon = game.gameId;
      if (!recording && !speaking) { mood('celebrate'); setTimeout(() => { if (ready && !recording && !speaking) mood('idle'); }, 2200); }
    }
  }
  if (view.judging && !recording && !speaking) mood('thinking');
  controls();
}
async function confirmAction(title, description) {
  const dialog = $('confirm-dialog'); $('confirm-title').textContent = title; $('confirm-description').textContent = description;
  return new Promise(resolve => {
    dialog.returnValue = ''; $('cancel').onclick = () => dialog.close('no'); $('confirm-yes').onclick = () => dialog.close('yes');
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'yes'), { once: true }); dialog.showModal();
  });
}
function send(value) { if (ws?.readyState !== WebSocket.OPEN) throw new Error('小矽还没有连接，请先唤醒。'); ws.send(JSON.stringify(value)); }
function stopPlayback() { responseEpoch++; audio.silence(); speaking = false; currentReply = null; }
async function sendText(text, label = '你 · 文字') {
  if (!ready || recording || micBusy || awaiting) return;
  try {
    await audio.resume(); if (!ready) return;
    awaiting = true; pendingEcho = normalized(text); controls();
    stopPlayback(); send({ type: 'say', text }); addMessage('user', text, label);
    mood('thinking'); bubble('收到啦，我在认真想你的问题。'); notice('文字指令也经过真实灵矽 Agent，不是本地规则回复。');
  } catch (error) { awaiting = false; controls(); notice(error.message, true); }
}
async function disconnect(sleep = true) {
  manualClose = true; epoch++; ready = false; connecting = false; recording = false; awaiting = false; pendingEcho = null;
  ws?.close(); stopPlayback(); await audio.close(); controls();
  connection(sleep ? '等待唤醒' : '连接已断开'); mood(sleep ? 'sleeping' : 'error');
  if (sleep) bubble('我先眯一会儿。想继续时，再来唤醒我。');
}
async function wake() {
  if (connecting || !isLocal) return;
  if (ready) return disconnect();
  const currentEpoch = ++epoch;
  connecting = true; manualClose = false; pairing = false; lastError = ''; autoStart = true;
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
      if (msg.type === 'ready') {
        ready = true; connecting = false; connection('灵矽已连接', true); mood('idle'); controls();
        notice('已接通真实灵矽。第一次说话会请求麦克风权限。');
        if (autoStart) { autoStart = false; void sendText('开始游戏', '你 · 开局按钮'); }
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
      }
      else if (msg.type === 'record_limit') { await stopRecord(false); notice('本次录音达到 45 秒，已自动发送并关闭麦克风。'); }
      else if (msg.type === 'tts') {
        if (msg.is_aborted) { stopPlayback(); if (ready && !recording) mood('idle'); }
        else if (msg.state === 'start') { awaiting = false; controls(); speaking = true; currentReply = null; mood('speaking'); }
        else if (msg.state === 'sentence_start' && msg.text) {
          speaking = true; mood('speaking'); bubble(msg.text, '灵矽正在播报');
          if (!currentReply) currentReply = addMessage('assistant', msg.text, '小矽 · 灵矽播报');
          else { currentReply.textContent += msg.text; $('conversation').scrollTop = $('conversation').scrollHeight; }
        } else if (msg.state === 'stop') {
          const response = responseEpoch;
          await audio.finished();
          if (currentEpoch === epoch && response === responseEpoch && ready && !recording) {
            speaking = false; mood(game?.status === 'won' ? 'celebrate' : 'idle');
            $('speech-source').textContent = '上一句 · 灵矽播报';
          }
        }
      }
    };
    ws.onerror = () => { if (currentEpoch === epoch) { lastError ||= '连接失败。请确认 pnpm pet 正在运行，其他桌宠窗口已关闭。'; notice(lastError, true); } };
    ws.onclose = () => {
      if (currentEpoch !== epoch) return;
      ready = false; connecting = false; recording = false; awaiting = false; stopPlayback(); void audio.close(); controls();
      if (!pairing && !manualClose) { connection('需要重新唤醒'); mood('error'); notice(lastError || '会话已结束，点击唤醒即可重新连接。', true); }
    };
  } catch (error) { connecting = false; ready = false; controls(); connection('尚未连接'); mood('error'); notice(error.message, true); }
}
async function startRecord() {
  if (!ready || recording || micBusy) return;
  micBusy = true; controls(); const currentEpoch = epoch;
  try {
    awaiting = false; pendingEcho = null; stopPlayback(); send({ type: 'abort' });
    await audio.startCapture(frame => { if (ready && recording && currentEpoch === epoch && ws.readyState === WebSocket.OPEN) ws.send(frame); });
    if (!ready || currentEpoch !== epoch) { await audio.stopCapture(); return; }
    send({ type: 'record', state: 'start' }); recording = true; mood('listening'); bubble('我在听。说完再点一次，把这句话交给我。');
    notice('麦克风正在采集；音频只发送给灵矽，不在本地保存。');
  } catch (error) {
    await audio.stopCapture(); recording = false; mood('idle');
    if (error.name === 'NotAllowedError') { document.body.classList.remove('compact'); localStorage.setItem('pet-compact', '0'); $('text').focus(); }
    notice(error.name === 'NotAllowedError' ? '麦克风未获授权，已展开文字模式。允许浏览器访问后可重试。' : error.message, true);
  } finally { micBusy = false; controls(); }
}
async function stopRecord(sendStop = true) {
  if (!recording || micBusy) return;
  micBusy = true; controls();
  try { await audio.stopCapture(); if (ready && sendStop) send({ type: 'record', state: 'stop' }); }
  finally { recording = false; micBusy = false; awaiting = ready; controls(); if (ready) { mood('thinking'); bubble('听完啦，正在想答案。'); notice('麦克风已关闭，等待灵矽回答。'); } }
}
$('wake').onclick = () => void wake();
$('mic').onclick = () => void (recording ? stopRecord() : startRecord());
$('interrupt').onclick = () => { if (!ready) return; awaiting = false; controls(); stopPlayback(); send({ type: 'abort' }); mood('idle'); bubble('暂停了。你可以继续问，也可以重听故事。'); };
$('hint').onclick = () => void sendText('给我提示', '你 · 提示按钮');
$('repeat').onclick = () => void sendText('重听题目', '你 · 重听按钮');
$('next').onclick = async () => {
  if (game?.status === 'playing') { if (await confirmAction('先换一道题？', '当前推理还没结束。确认后会放弃本题，开启下一题。')) await sendText('确认重开', '你 · 已确认换题'); }
  else await sendText('下一关', '你 · 下一题按钮');
};
$('start-game').onclick = async () => {
  if (!ready) return wake();
  if (game?.status === 'playing') return $('next').click();
  await sendText('开始游戏', '你 · 开局按钮');
};
$('reveal').onclick = async () => { if (await confirmAction('让真相揭晓？', '揭晓会结束本局，不获得通关分数。确定不再推理了吗？')) await sendText('确认揭晓', '你 · 已确认揭晓'); };
$('activation-close').onclick = () => $('activation').close();
$('mute').onclick = () => { muted = !muted; audio.setMuted(muted); $('mute').setAttribute('aria-pressed', String(muted)); $('mute').setAttribute('aria-label', muted ? '取消静音' : '静音'); $('mute').textContent = muted ? '♩' : '♫'; };
const setMode = value => { inputMode = value; $('ask-mode').classList.toggle('selected', value === 'ask'); $('answer-mode').classList.toggle('selected', value === 'answer'); $('text').placeholder = value === 'answer' ? '把完整的原因和实现方式说出来…' : '例如：和光线有关系吗？'; $('text').focus(); };
$('ask-mode').onclick = () => setMode('ask'); $('answer-mode').onclick = () => setMode('answer');
$('text-form').onsubmit = event => {
  event.preventDefault(); const text = $('text').value.trim(); if (!text || !ready || recording || micBusy || awaiting) return;
  $('text').value = ''; void sendText(inputMode === 'answer' && !/^(我的答案|提交答案|答案是)/.test(text) ? `我的答案是${text}` : text);
};
$('show-board').onclick = () => { document.body.classList.remove('compact'); localStorage.setItem('pet-compact', '0'); document.querySelector('.play-panel').scrollIntoView({ behavior: 'smooth', block: 'start' }); };
$('compact').onclick = () => { document.body.classList.toggle('compact'); localStorage.setItem('pet-compact', document.body.classList.contains('compact') ? '1' : '0'); };
if (new URL(location.href).searchParams.get('compact') === '1' || localStorage.getItem('pet-compact') === '1') document.body.classList.add('compact');
$('pet-touch').onclick = () => { if (!recording && !speaking && !connecting) { mood(ready ? 'celebrate' : 'idle'); bubble('摸摸已收到。准备好问一个好问题了吗？', '桌宠动作'); setTimeout(() => { if (!recording && !speaking && !connecting) mood(ready ? 'idle' : 'sleeping'); }, 1600); } };
window.addEventListener('pagehide', () => { ws?.close(); void audio.close(); });
controls();
if (!isLocal) {
  notice('这是外观预览。真实桌宠请在本机运行 pnpm pet，再打开 http://127.0.0.1:3212。', true);
  const link = document.createElement('a'); link.href = 'http://127.0.0.1:3212/'; link.textContent = ' 打开本机小矽 ↗'; $('notice').append(link);
  connection('外观预览'); bubble('真实的我住在你的电脑上。运行 pnpm pet，就能一起说话啦。');
} else {
  try {
    const r = await fetch('./api/config'); if (!r.ok) throw new Error('本机桌宠服务未启动，请运行 pnpm pet。');
    const config = await r.json();
    if (!config.engineOnline) notice('游戏服务未启动。运行 pnpm pet 会自动检查并启动本机服务。', true);
  } catch (error) { notice(error.message, true); }
}
