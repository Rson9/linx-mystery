// Animation geometry follows the public Codex v1 layout; artwork is project-specific.
export const SPRITE_ROWS = Object.freeze({ idle: [0, 6], right: [1, 8], left: [2, 8], wave: [3, 4], jump: [4, 5], failed: [5, 8], waiting: [6, 6], thinking: [7, 6], review: [8, 6] });
export function spriteFrame(mood, milliseconds, travel = null, reducedMotion = false) {
  let state = travel === 'left' || travel === 'right' ? travel : ({ sleeping: 'idle', idle: 'idle', listening: 'waiting', thinking: 'thinking', speaking: 'review', wave: 'wave', celebrate: 'jump', error: 'failed' })[mood] || 'idle';
  if ((state === 'jump' || state === 'failed') && milliseconds > 3000) state = mood === 'error' ? 'waiting' : 'idle';
  const [row, count] = SPRITE_ROWS[state], fps = mood === 'sleeping' ? 4 : 8;
  return { state, row, column: reducedMotion ? 0 : Math.floor(Math.max(0, milliseconds) / (1000 / fps)) % count };
}
export async function mountSprite(button, device) {
  const image = new Image(); image.src = new URL('./assets/xiaoxi.webp', import.meta.url).href;
  await image.decode();
  if (image.naturalWidth !== 1536 || image.naturalHeight !== 1872) throw new Error('角色动画尺寸无效');
  const canvas = document.createElement('canvas'); canvas.className = 'pet-canvas'; canvas.width = 192; canvas.height = 208; canvas.setAttribute('aria-hidden', 'true');
  button.append(canvas); button.classList.add('has-sprite');
  const ctx = canvas.getContext('2d'), motion = matchMedia('(prefers-reduced-motion: reduce)');
  let changed = performance.now(), previousKey = '', previousFrame = '', stopped = false;
  const draw = now => {
    if (stopped) return;
    const key = `${device.dataset.gesture || device.dataset.mood}:${device.dataset.travel || ''}`;
    if (key !== previousKey) { changed = now; previousKey = key; }
    const frame = spriteFrame(device.dataset.gesture || device.dataset.mood, now - changed, device.dataset.travel, motion.matches), signature = `${frame.row}:${frame.column}`;
    if (signature !== previousFrame) {
      ctx.clearRect(0, 0, 192, 208); ctx.drawImage(image, frame.column * 192, frame.row * 208, 192, 208, 0, 0, 192, 208);
      device.dataset.spriteState = frame.state; previousFrame = signature;
    }
    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw); window.addEventListener('pagehide', () => { stopped = true; }, { once: true });
}
