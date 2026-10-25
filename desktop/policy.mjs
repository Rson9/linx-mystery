export const PET_SIZE = { width: 320, height: 400 };
export const ACTIONS = ['wake', 'mic', 'interrupt', 'hint', 'repeat', 'next', 'library', 'replay', 'mute', 'board'];
export function trustedPage(raw, origin) {
  try { const url = new URL(raw); return url.origin === origin && url.pathname === '/' && !url.username && !url.password; } catch { return false; }
}
export function audioPermission(permission, details, origin) {
  return permission === 'media' && trustedPage(details.requestingUrl || details.securityOrigin || '', origin)
    && Array.isArray(details.mediaTypes) && details.mediaTypes.length > 0 && details.mediaTypes.every(type => type === 'audio');
}
export function normalizeRects(value, width, height) {
  if (!Array.isArray(value) || value.length > 100) return [];
  return value.filter(r => r && ['x', 'y', 'width', 'height'].every(k => Number.isFinite(r[k])) && r.width > 0 && r.height > 0)
    .map(r => ({ x: Math.max(0, r.x), y: Math.max(0, r.y), width: Math.min(width, r.x + r.width) - Math.max(0, r.x), height: Math.min(height, r.y + r.height) - Math.max(0, r.y) }))
    .filter(r => r.width > 0 && r.height > 0);
}
export function hitTest(point, bounds, rects) {
  return rects.some(r => point.x >= bounds.x + r.x && point.x < bounds.x + r.x + r.width && point.y >= bounds.y + r.y && point.y < bounds.y + r.y + r.height);
}
export function keepOnScreen(bounds, area) {
  const width = Math.min(bounds.width, area.width), height = Math.min(bounds.height, area.height);
  return { width, height, x: Math.round(Math.max(area.x, Math.min(bounds.x, area.x + area.width - width))), y: Math.round(Math.max(area.y, Math.min(bounds.y, area.y + area.height - height))) };
}
