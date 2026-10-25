// Explicit real-platform check: synthetic microphone input, muted output, existing bound identity only.
import { _electron, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
if (!process.argv.includes('--allow-platform')) { console.error('此命令使用真实灵矽；请显式传入 --allow-platform。仅使用预录音频，输出静音。'); process.exit(2); }
const root = dirname(dirname(fileURLToPath(import.meta.url))), identityPath = join(root, '.local/lingxi-device.json');
if (!existsSync(identityPath)) throw new Error('此检查只沿用已绑定设备，请先完成设备绑定');
const identityBefore = readFileSync(identityPath), temp = mkdtempSync(join(tmpdir(), 'misheng-native-live-'));
const output = resolve(root, 'eval-results', `desktop-${Date.now()}`); mkdirSync(output, { recursive: true });
const packaged = process.argv.includes('--packaged');
const executablePath = packaged ? join(root, `dist/谜声-darwin-${process.arch}/谜声.app/Contents/MacOS/MISHENG`) : createRequire(import.meta.url)('electron');
const checks = [], errors = []; let app, latest, pcmBytes = 0, sentPcmBytes = 0, inputPeak = 0, failure;
const pass = name => { checks.push(name); console.log(`PASS: ${name}`); };
const run = (cmd, args) => { if (spawnSync(cmd, args, { stdio: 'ignore' }).status !== 0) throw new Error('预录音频生成失败'); };
try {
  run('say', ['-v', 'Tingting', '--file-format=WAVE', '--data-format=LEI16@16000', '-o', join(temp, 'question.wav'), '回来时方向是相反的吗？']);
  run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', join(temp, 'question.wav'), '-af', 'adelay=2000,apad=pad_dur=3', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', join(temp, 'mic.wav')]);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.MISHENG_DESKTOP_TEST;
  const args = [...(packaged ? [] : [join(root, 'desktop/main.mjs')]), `--config-dir=${root}`, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${join(temp, 'mic.wav')}`, '--disable-features=AudioServiceSandbox', '--mute-audio'];
  app = await _electron.launch({ executablePath, args, env, timeout: 30000 }); const page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  page.on('websocket', socket => {
    socket.on('framereceived', ({ payload }) => {
      if (typeof payload !== 'string') { pcmBytes += payload.byteLength; return; }
      try { const data = JSON.parse(payload); if (data.type === 'game') latest = data.state; } catch {}
    });
    socket.on('framesent', ({ payload }) => {
      if (typeof payload === 'string') return;
      sentPcmBytes += payload.byteLength;
      for (let at = 0; at + 1 < payload.length; at += 2) inputPeak = Math.max(inputPeak, Math.abs(payload.readInt16LE(at)));
    });
  });
  const expandBoard = async () => {
    if (!await page.locator('html').evaluate(el => el.classList.contains('panel-open'))) {
      await page.locator('#pet-touch').click(); await page.locator('#desktop-board').click();
    }
    await expect(page.locator('.play-panel')).toBeVisible();
  };
  await expect(page.locator('#wake')).toBeEnabled(); await expect(page.locator('#pet-touch')).toHaveClass(/has-sprite/);
  await page.locator('#library-launcher').click(); await page.locator('[data-case-id="return-route"]').click();
  await page.locator('#wake').click(); await expect(page.locator('#case-status')).toHaveText('正在推理', { timeout: 45000 });
  await expect(page.locator('#send')).toBeEnabled({ timeout: 60000 }); pass('原生应用接入真实 Agent，游戏开局已确认');
  await expandBoard(); await page.waitForTimeout(2300); await page.screenshot({ path: join(output, 'board.png'), omitBackground: true });
  await page.locator('#desktop-board').click(); await page.waitForTimeout(9500); await page.screenshot({ path: join(output, 'pet.png'), omitBackground: true });
  await page.locator('#pet-touch').click(); await page.locator('#mic').click(); await expect(page.locator('#mic')).toHaveClass(/recording/);
  await page.waitForTimeout(6500); await page.locator('#mic').click();
  if (inputPeak < 100) throw new Error('预录输入未读到有效音频；请检查测试实例的文件读取与音频沙箱开关');
  await expect(page.locator('.message.user').last()).toContainText(/相反|方向/, { timeout: 30000 });
  await expect.poll(() => latest?.questions, { timeout: 45000 }).toBe(1); await expect(page.locator('#send')).toBeEnabled({ timeout: 60000 });
  if (!/^是的/.test(latest.history.at(-1).text)) throw new Error('真实语音问题未获得预期服务端判断');
  await expect(page.locator('.message.assistant').last().locator('span')).toContainText(/^是的/); pass('Electron 假麦克风经真实 ASR、MCP 与 PCM TTS 完成提问');
  await expandBoard();
  async function textTurn(text, expected) {
    await expect(page.locator('#send')).toBeEnabled({ timeout: 60000 }); const revision = latest.revision;
    await page.locator('#ask-mode').click(); await page.locator('#text').fill(text); await page.locator('#send').click();
    await expect.poll(() => latest?.revision > revision && latest.history?.at(-2)?.text === text, { timeout: 45000 }).toBe(true);
    if (!expected.test(latest.history.at(-1).text)) throw new Error('服务端结果不符');
    await expect(page.locator('.message.assistant').last().locator('span')).toContainText(expected); await expect(page.locator('#send')).toBeEnabled({ timeout: 60000 });
  }
  await textTurn('她走错是因为道路临时被封住了吗？', /^不是/); pass('自由问题经真实语义判断，原话与服务端记录对应');
  await page.locator('#hint').click(); await expect(page.locator('#hints')).toHaveText('1', { timeout: 30000 }); await expect(page.locator('#send')).toBeEnabled({ timeout: 60000 });
  await textTurn('我的答案是沿原路回去时面对的方向反了，原来的左转变成右转。因此指令既要倒序，又要互换左右。', /推理正确/);
  await expect(page.locator('#result-title')).toHaveText('破案成功 · 85 分');
  if (!latest.replay?.steps.some(step => step.kind === 'answer' && step.source === 'agent-judgment')) throw new Error('缺少真实语义裁判回放');
  if (pcmBytes <= 0) throw new Error('未收到真实 PCM'); pass('一次提示、真实语义作答与服务端 85 分结算');
  await expandBoard(); await page.locator('#result-replay').click(); await expect(page.locator('#replay-steps')).toContainText('封住');
  await page.screenshot({ path: join(output, 'replay.png'), omitBackground: true });
  const cardPath = join(output, 'case-card.png');
  await app.evaluate(({ session }, path) => { session.defaultSession.once('will-download', (_event, item) => item.setSavePath(path)); }, cardPath);
  await page.locator('#replay-share').click(); await expect.poll(() => existsSync(cardPath) && readFileSync(cardPath).length > 32).toBe(true);
  const png = readFileSync(cardPath); if (png.readUInt32BE(16) !== 1080 || png.readUInt32BE(20) !== 1350) throw new Error('破案卡尺寸不符');
  pass('原生回放与角色破案卡下载'); await page.locator('#replay-close').click(); await page.locator('#wake').click();
  await expect(page.locator('#connection')).toContainText('等待唤醒'); if (errors.length) throw new Error('原生页面异常'); pass('休眠断开');
} catch (error) { failure = error.message; console.error('FAIL:', error.message); process.exitCode = 1; }
finally {
  await app?.close().catch(() => {}); rmSync(temp, { recursive: true, force: true });
  const identityUnchanged = identityBefore.equals(readFileSync(identityPath)); if (!identityUnchanged) process.exitCode = 1;
  writeFileSync(join(output, 'report.json'), JSON.stringify({ packaged, checks, errors, failure, pcmBytes, sentPcmBytes, inputPeak, syntheticFileAudioSandboxDisabled: true, identityUnchanged, score: latest?.score,
    prerecordedMicrophone: true, physicalMicrophoneUsed: false, speakerMuted: true }, null, 2));
  console.log(`原生平台验证记录：${output}`);
}
