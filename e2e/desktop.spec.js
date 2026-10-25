import { test, expect, _electron as electron } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const executablePath = createRequire(import.meta.url)('electron');
test.describe.configure({ mode: 'serial' });
async function launch() {
  const profile = mkdtempSync(join(tmpdir(), 'misheng-native-test-'));
  const app = await electron.launch({ executablePath, args: [resolve('desktop/main.mjs')], env: { ...process.env,
    MISHENG_DESKTOP_TEST: '1', MISHENG_LOCAL_AUTH_KEY: 'b'.repeat(64), MISHENG_DESKTOP_TEST_DIR: profile, PORT: '3211', PET_PORT: '3215', LINX_SERVICE_TOKEN: '', AI_HOST_ENABLED: '', LINX_AGENT_HOST_ENABLED: '', PUBLIC_ORIGIN: '' } });
  const page = await app.firstWindow(); await expect(page.locator('html')).toHaveClass(/desktop/); await expect(page.locator('#wake')).toBeEnabled();
  return { app, page, close: async () => { await app.close(); rmSync(profile, { recursive: true, force: true }); } };
}
test('原生透明置顶窗口、隔离桥、穿透区域与推理台展开（模拟 Agent）', async () => {
  const { app, page, close } = await launch();
  try {
    const properties = await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; return { top: w.isAlwaysOnTop(), resize: w.isResizable(), color: w.getBackgroundColor(), prefs: w.webContents.getLastWebPreferences() }; });
    expect(properties.top).toBe(true); expect(properties.resize).toBe(false); expect(properties.color).toMatch(/^#000000(?:00)?$/);
    expect(properties.prefs.contextIsolation).toBe(true); expect(properties.prefs.nodeIntegration).toBe(false); expect(properties.prefs.sandbox).toBe(true);
    expect(await page.evaluate(() => typeof window.require)).toBe('undefined');
    await expect(page.locator('#pet-touch')).toHaveClass(/has-sprite/);
    const transparent = await app.evaluate(async ({ BrowserWindow }) => {
      const image = await BrowserWindow.getAllWindows()[0].capturePage(), data = image.toBitmap(); let zero = 0, painted = 0;
      for (let i = 3; i < data.length; i += 4) { if (data[i] === 0) zero++; else painted++; } return { zero, painted };
    });
    expect(transparent.zero).toBeGreaterThan(3000); expect(transparent.painted).toBeGreaterThan(3000);
    await page.locator('#desktop-board').click(); await expect(page.locator('.play-panel')).toBeVisible();
    expect((await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds())).width).toBeGreaterThan(320);
    await page.locator('#desktop-board').click(); await expect(page.locator('.play-panel')).toBeHidden();
    await page.locator('#library-launcher').click(); await expect(page.locator('#library-dialog')).toBeVisible(); await expect(page.locator('.story-card')).toHaveCount(8);
    await page.locator('#library-close').click(); await expect(page.locator('html')).not.toHaveClass(/panel-open/);
    await page.screenshot({ path: 'test-results/native-pet.png', omitBackground: true });
  } finally { await close(); }
});
test('原生拖动使用受限坐标，结束后恢复；外部导航与弹窗被阻止', async () => {
  const { app, page, close } = await launch();
  try {
    const before = await app.evaluate(({ BrowserWindow }) => {
      const b = BrowserWindow.getAllWindows()[0].getBounds();
      process.__mishengTestPointer = { x: b.x + 160, y: b.y + 240 }; return b;
    });
    await page.evaluate(() => window.mishengDesktop.drag('start')); await page.waitForTimeout(100);
    await app.evaluate(() => { process.__mishengTestPointer.x -= 35; });
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds().x)).toBe(before.x - 35);
    await expect(page.locator('#pet-device')).toHaveAttribute('data-travel', 'left');
    await app.evaluate(() => { process.__mishengTestPointer.x += 20; });
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds().x)).toBe(before.x - 15);
    await expect(page.locator('#pet-device')).toHaveAttribute('data-travel', 'right');
    await page.evaluate(() => window.mishengDesktop.drag('stop'));
    await app.evaluate(() => { delete process.__mishengTestPointer; });
    await page.evaluate(() => { window.open('https://example.com/'); });
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    await page.evaluate(() => { location.href = 'https://example.com/'; }); await page.waitForTimeout(250);
    expect(new URL(page.url()).hostname).toBe('127.0.0.1');
  } finally { await close(); }
});
test('原生桌宠录音、文字、提示、85 分回放和权限回退（模拟 Agent 与假麦克风）', async () => {
  const { page, close } = await launch(); const errors = []; page.on('pageerror', e => errors.push(e.message));
  try {
    await page.locator('#wake').click(); await expect(page.locator('#case-status')).toHaveText('正在推理');
    await page.locator('#mic').click(); await expect(page.locator('#mic')).toHaveClass(/recording/); await page.waitForTimeout(300); await page.locator('#mic').click();
    await expect(page.locator('#send')).toBeEnabled();
    await page.locator('#desktop-board').click();
    await page.locator('#text').fill('回程时，她面对的方向与来时相反吗？'); await page.locator('#send').click();
    await expect(page.locator('#questions')).toHaveText('2');
    await page.locator('#hint').click(); await expect(page.locator('#hints')).toHaveText('1');
    await expect(page.locator('#send')).toBeEnabled();
    await page.locator('#answer-mode').click(); await page.locator('#text').fill('回程面对的方向相反，所以除了倒序还要左右互换'); await page.locator('#send').click();
    await expect(page.locator('#result-title')).toHaveText('破案成功 · 85 分');
    await page.locator('#result-replay').click(); await expect(page.locator('#replay-steps')).toContainText('回程时'); await page.locator('#replay-close').click();
    await page.locator('#desktop-board').click(); await page.locator('#pet-touch').click();
    await page.evaluate(() => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('denied', 'NotAllowedError'); }; });
    await page.locator('#mic').click(); await expect(page.locator('html')).toHaveClass(/panel-open/); await expect(page.locator('#text')).toBeVisible();
    await expect(page.locator('#notice')).toContainText('麦克风未获授权'); expect(errors).toEqual([]);
    await page.locator('#wake').click();
  } finally { await close(); }
});
