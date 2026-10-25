// 显式选择的真实平台验收。用预录音频替代麦克风，并静音，不录制/播放本机真人音频。
import { chromium, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
if (!process.argv.includes('--allow-platform')) {
  console.error('此检查使用真实灵矽资源。确认后运行 pnpm pet:check --allow-platform；需要 macOS say、ffmpeg 和 Chrome。');
  process.exit(2);
}
const temp = mkdtempSync(join(tmpdir(), 'misheng-pet-check-'));
const output = resolve('eval-results', `pet-ui-${Date.now()}`); mkdirSync(output, { recursive: true });
const run = (cmd, args) => { const r = spawnSync(cmd, args, { stdio: 'ignore' }); if (r.status !== 0) throw new Error(`测试音频生成失败，请确认 ${cmd} 已安装。`); };
let browser, page; const checks = [], errors = [];
const pass = name => { checks.push({ name, passed: true }); console.log(`PASS: ${name}`); };
try {
  if (process.platform !== 'darwin') throw new Error('当前预录音频检查脚本仅适用于 macOS；桌宠本身不依赖 say/ffmpeg。');
  run('say', ['-v', 'Tingting', '--file-format=WAVE', '--data-format=LEI16@16000', '-o', join(temp, 'question.wav'), '房主听力正常吗？']);
  run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', join(temp, 'question.wav'), '-af', 'adelay=2000,apad=pad_dur=3', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', join(temp, 'mic.wav')]);
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${join(temp, 'mic.wav')}`, '--mute-audio'] });
  const context = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1360, height: 1000 } });
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${process.env.PET_PORT || 3212}/?case=silent-bell`);
  await page.locator('#wake').click();
  await expect(page.locator('#connection')).toContainText('灵矽已连接', { timeout: 30000 });
  await expect(page.locator('#case-title')).toHaveText('没有响的门铃', { timeout: 30000 });
  await expect(page.locator('#case-status')).toHaveText('正在推理', { timeout: 30000 }); pass('真实 Agent 开局与游戏状态同步');
  await page.locator('#mic').click(); await expect(page.locator('#mic')).toHaveClass(/recording/, { timeout: 15000 });
  await page.waitForTimeout(4400); await page.locator('#mic').click();
  await expect(page.locator('.message.user').last()).toContainText('房主听力正常吗', { timeout: 30000 });
  await expect(page.locator('.message.assistant').last()).toHaveText(/不是。/, { timeout: 30000 });
  await expect(page.locator('#questions')).toHaveText('1', { timeout: 15000 }); pass('浏览器预录输入 → 真实 ASR / Agent / PCM TTS');
  await page.locator('#text').fill('房主穿蓝色衣服吗？'); await page.locator('#send').click();
  await expect(page.locator('.message.assistant').last()).toContainText('无法确定', { timeout: 30000 }); pass('未记载细节不编造');
  await page.locator('#hint').click();
  await expect(page.locator('.message.assistant').last()).toContainText('提示', { timeout: 30000 });
  await expect(page.locator('#hints')).toHaveText('1', { timeout: 15000 }); pass('提示只扣一次');
  await page.locator('#answer-mode').click(); await page.locator('#text').fill('屋主有听觉障碍，门口按钮让屋内的提示灯闪亮，他看见信号去开门。'); await page.locator('#send').click();
  await expect(page.locator('#result-title')).toHaveText('破案成功 · 85 分', { timeout: 45000 });
  await expect(page.locator('.message.assistant').last()).toContainText('推理正确', { timeout: 30000 }); pass('语义判题、一次提示、85 分结算');
  await page.screenshot({ path: join(output, 'desktop-won.png'), fullPage: true });
  await page.locator('#compact').click(); await page.setViewportSize({ width: 400, height: 740 });
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.screenshot({ path: join(output, 'compact-won.png'), fullPage: true });
  await page.locator('#next').click(); await expect(page.locator('#case-title')).toHaveText('雨天的十八楼', { timeout: 30000 });
  await expect(page.locator('#case-status')).toHaveText('正在推理', { timeout: 30000 }); pass('切换下一题');
  if (errors.length) throw new Error('浏览器发生脚本错误');
  await page.locator('#wake').click(); await expect(page.locator('#connection')).toContainText('等待唤醒'); pass('休眠断开并关闭音频');
} catch (error) {
  console.error('真实界面验收未完成：' + error.message);
  checks.push({ name: 'current-step', passed: false, errorKind: error.name });
  if (page) { await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {}); }
  process.exitCode = 1;
} finally {
  await browser?.close(); rmSync(temp, { recursive: true, force: true });
  writeFileSync(join(output, 'report.json'), JSON.stringify({ checks, errors, prerecordedMicrophone: true, physicalMicrophoneUsed: false, speakerMuted: true }, null, 2));
  console.log(`本机验收记录：${output}`);
}
