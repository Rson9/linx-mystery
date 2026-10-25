import { mountSprite } from './sprite.js';
const $ = id => document.getElementById(id);
export async function mountDesktop() {
  const bridge = window.mishengDesktop;
  document.documentElement.classList.add('desktop'); document.body.classList.remove('compact');
  const style = document.createElement('link'); style.rel = 'stylesheet'; style.href = new URL('./desktop.css', import.meta.url).href;
  const loaded = new Promise(resolve => { style.onload = resolve; style.onerror = resolve; }); document.head.append(style); await loaded;
  let manualPanel = false, frame = 0, dragged = false, controlsTimer, bubbleTimer;
  const toolbar = document.createElement('nav'); toolbar.id = 'desktop-toolbar'; toolbar.setAttribute('aria-label', '桌宠操作');
  const board = document.createElement('button'); board.id = 'desktop-board'; board.textContent = '推理台 ↗'; board.title = '展开或收起推理台';
  const more = document.createElement('button'); more.id = 'desktop-more'; more.textContent = '···'; more.setAttribute('aria-label', '桌宠菜单');
  toolbar.append(board, more); document.body.append(toolbar);
  const svg = document.querySelector('#pet-touch svg'), originalViewBox = svg.getAttribute('viewBox');
  const setPanel = () => {
    const expanded = manualPanel || [...document.querySelectorAll('dialog')].some(d => d.open);
    document.documentElement.classList.toggle('panel-open', expanded); board.textContent = expanded ? '收回桌面' : '推理台 ↗';
    svg.setAttribute('viewBox', expanded ? originalViewBox : '35 0 270 335');
    void bridge?.expanded(expanded); schedule();
  };
  board.onclick = () => { manualPanel = !manualPanel; setPanel(); };
  $('show-board').onclick = () => { manualPanel = true; setPanel(); };
  window.addEventListener('pet:show-board', () => { manualPanel = true; setPanel(); });
  $('compact').onclick = () => { manualPanel = false; setPanel(); };
  function showControls() {
    clearTimeout(controlsTimer); document.documentElement.classList.add('controls-open');
    controlsTimer = setTimeout(() => { if (!$('mic').classList.contains('recording')) document.documentElement.classList.remove('controls-open'); schedule(); }, 7000);
    schedule();
  }
  const touched = $('pet-touch').onclick;
  $('pet-touch').onclick = event => {
    if (dragged) return;
    touched?.(event);
    if (!document.querySelector('#connection').classList.contains('online')) {
      $('pet-device').dataset.gesture = 'wave'; setTimeout(() => { delete $('pet-device').dataset.gesture; }, 520);
    }
    showControls();
  };
  $('pet-touch').title = '点击摸摸小矽 · 拖动换位置 · 右键菜单';
  $('pet-touch').onpointerdown = event => { if (event.button === 0 && !manualPanel) { dragged = false; $('pet-touch').setPointerCapture(event.pointerId); bridge?.drag('start'); } };
  window.addEventListener('pointerup', () => { bridge?.drag('stop'); setTimeout(() => { dragged = false; }, 150); });
  window.addEventListener('pointercancel', () => bridge?.drag('stop'));
  bridge?.onDrag((moved, direction) => {
    if (moved) dragged = true;
    if (direction) $('pet-device').dataset.travel = direction;
    else { delete $('pet-device').dataset.travel; setTimeout(() => { dragged = false; }, 150); }
  });
  document.addEventListener('contextmenu', event => { if (bridge) { event.preventDefault(); bridge.menu(); } });
  more.onclick = () => { if (bridge) bridge.menu(); else showControls(); };
  const actions = { wake: 'wake', mic: 'mic', interrupt: 'interrupt', hint: 'hint', repeat: 'repeat', next: 'next', library: 'library-launcher', replay: 'open-replay', mute: 'mute' };
  bridge?.onAction(action => {
    if (action === 'board') { board.click(); return; }
    const target = $(actions[action]);
    if (target && !target.disabled && !target.hidden) { target.click(); showControls(); }
  });
  const dialogs = [...document.querySelectorAll('dialog')];
  for (const d of dialogs) {
    new MutationObserver(setPanel).observe(d, { attributes: true, attributeFilter: ['open'] }); d.addEventListener('close', setPanel);
  }
  function visible(el) {
    for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
      const s = getComputedStyle(e); if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
    }
    return true;
  }
  function report() {
    frame = 0;
    const elements = document.documentElement.classList.contains('panel-open') ? [document.body] : [
      $('pet-touch'), document.querySelector('.speech'), document.querySelector('.voice-controls'), document.querySelector('.quick-actions'), toolbar,
      ...document.querySelectorAll('.notice.error')
    ];
    const rects = elements.filter(el => el && visible(el)).map(el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
    bridge?.hitAreas(rects); bridge?.state({ ready: document.querySelector('#connection').classList.contains('online'), recording: $('mic').classList.contains('recording') });
  }
  function schedule() { if (!frame) frame = requestAnimationFrame(report); }
  new MutationObserver(schedule).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'disabled', 'class', 'data-mood'] });
  const speech = document.querySelector('.speech');
  new MutationObserver(() => {
    clearTimeout(bubbleTimer); document.documentElement.classList.add('bubble-open'); schedule();
    const hide = () => { if ($('pet-device').dataset.mood === 'speaking') { bubbleTimer = setTimeout(hide, 3000); return; } document.documentElement.classList.remove('bubble-open'); schedule(); };
    bubbleTimer = setTimeout(hide, 9000);
  }).observe($('speech-text'), { childList: true, characterData: true, subtree: true });
  for (const el of [speech, toolbar, document.querySelector('.voice-controls'), document.querySelector('.quick-actions')]) {
    el.addEventListener('mouseenter', schedule); el.addEventListener('mouseleave', schedule);
  }
  document.querySelector('.companion').addEventListener('mouseenter', () => { showControls(); schedule(); });
  let lastHover = 0;
  $('pet-touch').addEventListener('pointermove', () => { if (!dragged && performance.now() - lastHover > 250) { lastHover = performance.now(); showControls(); } });
  window.addEventListener('resize', schedule); document.addEventListener('transitionend', schedule);
  const interval = setInterval(schedule, 300);
  window.addEventListener('pagehide', () => { clearInterval(interval); clearTimeout(controlsTimer); clearTimeout(bubbleTimer); });
  setPanel(); showControls();
  await mountSprite($('pet-touch'), $('pet-device')).catch(() => { /* Existing vector character remains usable when artwork cannot load. */ });
  schedule();
}
