import test from 'node:test';
import assert from 'node:assert/strict';
import { trustedPage, audioPermission, normalizeRects, hitTest, keepOnScreen } from '../desktop/policy.mjs';
import { SPRITE_ROWS, spriteFrame } from '../public/pet/sprite.js';

test('原生桥只信任本机主页面，拒绝其他端口、外部页面与内嵌路径', () => {
  const origin = 'http://127.0.0.1:3212';
  assert.equal(trustedPage(origin + '/?desktop=1', origin), true);
  for (const url of ['http://127.0.0.1:3213/', 'https://example.com/', origin + '/pet/', 'file:///etc/passwd', 'javascript:alert(1)', 'http://name:password@127.0.0.1:3212/']) assert.equal(trustedPage(url, origin), false);
});
test('原生权限仅允许可信来源的纯音频请求，不开放视频或屏幕采集', () => {
  const origin = 'http://127.0.0.1:3212', details = { requestingUrl: origin + '/?desktop=1', mediaTypes: ['audio'] };
  assert.equal(audioPermission('media', details, origin), true);
  assert.equal(audioPermission('display-capture', details, origin), false);
  for (const types of [[], ['video'], ['audio', 'video'], undefined]) assert.equal(audioPermission('media', { ...details, mediaTypes: types }, origin), false);
  assert.equal(audioPermission('media', { ...details, requestingUrl: 'https://example.com/' }, origin), false);
});
test('透明区域穿透采用有限可见区域，异常矩形不能扩大窗口权限', () => {
  const rects = normalizeRects([{ x: 80, y: 110, width: 160, height: 210 }, { x: NaN, y: 0, width: 500, height: 500 }, { x: 0, y: 0, width: -5, height: 5 }], 320, 400);
  assert.equal(rects.length, 1);
  assert.equal(hitTest({ x: 200, y: 250 }, { x: 100, y: 100 }, rects), true);
  assert.equal(hitTest({ x: 110, y: 110 }, { x: 100, y: 100 }, rects), false);
  assert.deepEqual(normalizeRects(new Array(101).fill({ x: 0, y: 0, width: 1, height: 1 }), 320, 400), []);
});
test('拖动与屏幕变化保持窗口可见，支持负坐标显示器', () => {
  assert.deepEqual(keepOnScreen({ x: -2000, y: 900, width: 320, height: 400 }, { x: -1440, y: 0, width: 1440, height: 900 }), { x: -1440, y: 500, width: 320, height: 400 });
});
test('精灵动画覆盖九类动作且不读取任何透明空槽，减少动态效果时冻结动作', () => {
  assert.equal(Object.values(SPRITE_ROWS).reduce((n, [, count]) => n + count, 0), 57);
  for (const mood of ['sleeping', 'idle', 'listening', 'thinking', 'speaking', 'celebrate', 'error', 'unknown']) for (let ms = 0; ms < 10000; ms += 37) {
    const f = spriteFrame(mood, ms); assert.ok(f.column < SPRITE_ROWS[f.state][1]); assert.ok(f.row >= 0 && f.row <= 8);
  }
  assert.equal(spriteFrame('thinking', 375).state, 'thinking'); assert.equal(spriteFrame('listening', 375).state, 'waiting');
  assert.equal(spriteFrame('idle', 375, 'left').state, 'left'); assert.equal(spriteFrame('celebrate', 375).state, 'jump');
  assert.equal(spriteFrame('idle', 999, null, true).column, 0);
});
