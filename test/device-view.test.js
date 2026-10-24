import test from 'node:test';
import assert from 'node:assert/strict';
import { DeviceViews, normalizeUtterance } from '../src/device-view.js';
test('设备游戏视图按设备和会话隔离，MAC 大小写归一', () => {
  const views = new DeviceViews(); views.remember('02:AA:BB:CC:DD:EE', 's1', 'owner');
  assert.equal(views.lookup('02:aa:bb:cc:dd:ee', 's1'), 'owner');
  assert.equal(views.lookup('other', 's1'), null); assert.equal(views.lookup('02:aa:bb:cc:dd:ee', 's2'), null);
});
test('不同智能体产生歧义时拒绝读取，映射过期并限制内存', () => {
  let now = 0; const views = new DeviceViews({ now: () => now, ttlMs: 100, maxEntries: 2 });
  views.remember('a', 's', 'one'); views.remember('a', 's', 'two');
  assert.throws(() => views.lookup('a', 's'));
  now = 101; assert.equal(views.lookup('a', 's'), null);
  for (const key of ['a', 'b', 'c']) views.remember(key, 's', key);
  assert.equal(views.entries.size, 2); assert.equal(views.lookup('a', 's'), null);
  views.setInput('c', 's', 'input-one', '给我提示');
  views.setInput('c', 's', 'input-one', '给我提示。');
  assert.equal(views.currentInput('c', 's').inputId, 'input-one');
  assert.throws(() => views.setInput('c', 's', 'input-one', '揭晓答案'));
  assert.equal(normalizeUtterance('“给我提示。”'), '给我提示');
  now += 120001; assert.equal(views.currentInput('c', 's'), null);
});
