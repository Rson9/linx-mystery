import { _electron, expect } from '@playwright/test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const executablePath = resolve(root, `dist/谜声-darwin-${process.arch}/谜声.app/Contents/MacOS/MISHENG`);
if (!existsSync(executablePath)) throw new Error('先运行 pnpm desktop:build');
const profile = mkdtempSync(join(tmpdir(), 'misheng-bundle-smoke-'));
let app;
try {
  app = await _electron.launch({ executablePath, env: { ...process.env, MISHENG_DESKTOP_TEST: '1', MISHENG_DESKTOP_TEST_DIR: profile,
    PORT: '3320', PET_PORT: '3322', PET_GAME_ORIGIN: '', LINX_SERVICE_TOKEN: '', LLM_API_KEY: '', LINX_AGENT_HOST_ENABLED: '', AI_HOST_ENABLED: '', PUBLIC_ORIGIN: '' }, timeout: 30000 });
  const page = await app.firstWindow(); await expect(page.locator('#pet-touch')).toHaveClass(/has-sprite/); await expect(page.locator('#wake')).toBeEnabled();
  const catalog = await (await fetch('http://127.0.0.1:3320/api/catalog')).json();
  if (catalog.cases.length !== 8) throw new Error('打包题库不完整');
  const health = await (await fetch('http://127.0.0.1:3322/healthz')).json();
  if (health.service !== 'misheng-pet') throw new Error('打包桌面服务不可用');
  if (existsSync(join(profile, '.local/lingxi-device.json'))) throw new Error('检查不应创建设备身份');
  console.log('打包应用、内置 Node/SQLite、题库、桌面桥和角色图已加载；未访问平台或创建设备。');
} finally {
  await app?.close(); rmSync(profile, { recursive: true, force: true });
}
await new Promise(resolve => setTimeout(resolve, 300));
for (const port of [3320, 3322]) {
  let online = false;
  try { await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) }); online = true; } catch {}
  if (online) throw new Error(`退出后未停止自有服务：${port}`);
}
console.log('退出已关闭应用自有服务，外部服务不受影响。');
