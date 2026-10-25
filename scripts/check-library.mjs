// 真实平台验收：浏览器 fake microphone 使用 say 预录输入，扬声器静音，不采集真人。
import { chromium, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
if (!process.argv.includes('--allow-platform')) { console.error('此检查调用真实灵矽。运行 pnpm library:check:live --allow-platform；需 Mac say、ffmpeg、Chrome。'); process.exit(2); }
const temp = mkdtempSync(join(tmpdir(), 'misheng-library-'));
const output = resolve('eval-results', `library-${Date.now()}`); mkdirSync(output, { recursive: true });
const controllerOnly = process.argv.includes('--controller-only');
if (controllerOnly) console.log('诊断模式：验证服务端执行与计分，记录平台播报，不认证语音内容正确性。');
const checks = [], errors = [], results = [], rounds = [], speechDeviations = []; let browser, page, latestGame, speechSequence = 0, currentSpeech = null, completedSpeech = null;
const run = (cmd, args) => { if (spawnSync(cmd, args, { stdio: 'ignore' }).status !== 0) throw new Error(`${cmd} 无法生成测试音频`); };
const pass = name => { checks.push({ name, passed: true }); console.log(`${controllerOnly ? 'CONTROLLER PASS' : 'PASS'}: ${name}`); };
const expectText = (locator, expected) => expect(locator).toContainText(expected, { timeout: 45000 });
async function ask(text, expected) {
  const before = await page.locator('.message.assistant').count(), started = Date.now(), revision = latestGame?.revision ?? -1, previousSpeech = speechSequence;
  await page.locator('#ask-mode').click(); await page.locator('#text').fill(text); await page.locator('#send').click();
  // 口头回答不能代替工具执行：必须有本次原话对应的新服务端结果。
  await expect.poll(() => Boolean(latestGame && latestGame.revision > revision && latestGame.history?.at(-2)?.text === text), { timeout: 45000 }).toBe(true);
  const canonical = latestGame.history.at(-1).text;
  if (typeof expected === 'string' ? !canonical.includes(expected) : !expected.test(canonical)) throw new Error('服务端结果与预期不符');
  await expect.poll(() => page.locator('.message.assistant').count(), { timeout: 45000 }).toBeGreaterThan(before);
  const spokenExpected = expected === '是的。' ? /^是的[，,。！!]?/ : expected === '不是。' ? /^不是[，,。！!]?/ : expected;
  let spoken;
  if (controllerOnly) {
    await expect.poll(() => Boolean(completedSpeech && completedSpeech.sequence > previousSpeech), { timeout: 60000 }).toBe(true);
    spoken = completedSpeech.text.trim();
  } else {
    await expectText(page.locator('.message.assistant').last().locator('span'), spokenExpected);
    spoken = (await page.locator('.message.assistant').last().locator('span').innerText()).trim();
  }
  if (spoken !== canonical) speechDeviations.push({ canonical, spoken: spoken.slice(0, 600) });
  results.push({ operation: text.startsWith('我的答案') ? 'answer' : 'question', elapsedMs: Date.now() - started, canonical, spoken: spoken.slice(0, 600) });
}
async function answer(text, score) {
  await ask(`我的答案是${text}`, '推理正确');
  await expect(page.locator('#result-title')).toHaveText(`破案成功 · ${score} 分`, { timeout: 15000 });
  const replay = latestGame?.replay; if (!replay || replay.score !== score) throw new Error('缺少对应的服务端结算回放');
  const questions = replay.steps.filter(e => e.kind === 'question'), answers = replay.steps.filter(e => e.kind === 'answer');
  if (!answers.length || answers.some(e => e.source !== 'agent-judgment')) throw new Error('作答未经过真实 Agent 结构化裁判');
  const questionRoutes = Object.fromEntries([...new Set(questions.map(e => e.source))].map(source => [source, questions.filter(e => e.source === source).length]));
  if (replay.caseId === 'return-route' && (!questionRoutes['standard-question'] || !questionRoutes['agent-judgment'])) throw new Error('未同时验证标准问法与自由语义路径');
  rounds.push({ caseId: replay.caseId, score, questions: replay.questions, hints: replay.hintsUsed, attempts: replay.attempts, questionRoutes, semanticAnswers: answers.length });
}
try {
  if (process.platform !== 'darwin') throw new Error('当前预录音频检查脚本仅支持 macOS');
  run('say', ['-v', 'Tingting', '--file-format=WAVE', '--data-format=LEI16@16000', '-o', join(temp, 'question.wav'), '回来时方向是相反的吗？']);
  run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', join(temp, 'question.wav'), '-af', 'adelay=2000,apad=pad_dur=3', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', join(temp, 'mic.wav')]);
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${join(temp, 'mic.wav')}`, '--mute-audio'] });
  const context = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1360, height: 1000 } });
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  page.on('websocket', socket => { if (new URL(socket.url()).pathname !== '/voice') return; socket.on('framereceived', ({ payload }) => {
    if (typeof payload !== 'string') return;
    try {
      const data = JSON.parse(payload);
      if (data.type === 'game') latestGame = data.state;
      if (data.type === 'tts' && !data.is_aborted) {
        if (data.state === 'start') currentSpeech = { sequence: ++speechSequence, text: '' };
        if (data.state === 'sentence_start' && currentSpeech) currentSpeech.text += data.text || '';
        if (data.state === 'stop' && currentSpeech) completedSpeech = { ...currentSpeech };
      }
    } catch {}
  }); });
  await page.goto(`http://127.0.0.1:${process.env.PET_PORT || 3212}/`);
  await expect(page.locator('#case-title')).toHaveText('回不去的三句话');
  await page.locator('#library-launcher').click(); await expect(page.locator('.story-card')).toHaveCount(8);
  await page.screenshot({ path: join(output, 'library.png') }); await page.locator('#library-close').click();
  await page.locator('#wake').click(); await expect(page.locator('#case-status')).toHaveText('正在推理', { timeout: 45000 });
  if (!controllerOnly) await expectText(page.locator('.message.assistant').last(), '回不去的三句话');
  pass('默认新题开局与八题题库');
  await page.locator('#mic').click(); await expect(page.locator('#mic')).toHaveClass(/recording/, { timeout: 15000 });
  await page.waitForTimeout(6500); await page.locator('#mic').click();
  await expectText(page.locator('.message.user').last(), '相反');
  if (!controllerOnly) await expectText(page.locator('.message.assistant').last(), /是的|方向(?:确实)?是相反/);
  await expect(page.locator('#questions')).toHaveText('1', { timeout: 15000 });
  if (latestGame?.lastVerdict !== 'yes') throw new Error('语音确认与服务端判词不一致');
  pass('新题预录浏览器语音 → 真实 ASR / Agent 调用标准问法 / PCM TTS');
  await page.locator('#hint').click();
  if (!controllerOnly) await expectText(page.locator('.message.assistant').last(), '另一头');
  await expect(page.locator('#hints')).toHaveText('1', { timeout: 15000 });
  if (!latestGame.history.at(-1).text.includes('另一头')) throw new Error('服务端未跳过重复提示');
  pass('已经明确问到的方向不重复提示，跳级只扣一次');
  await ask('她走错是因为道路临时被封住了吗？', '不是。');
  await expect(page.locator('#questions')).toHaveText('2', { timeout: 15000 }); pass('未内置的自然语言问法由真实 Agent 语义判断');
  await ask('小林穿蓝色衣服吗？', /无法确定|未知/);
  await answer('沿原路回来的时候面对的方向相反，每个原来的右转就成了左转，所以除了把先后倒过来，还得交换左右。', 85);
  await page.locator('#result-replay').click(); await expectText(page.locator('#replay-steps'), '相反');
  await page.screenshot({ path: join(output, 'route-replay.png') });
  const downloadPromise = page.waitForEvent('download'); await page.locator('#replay-share').click(); await (await downloadPromise).saveAs(join(output, 'case-card.png'));
  if (process.argv.includes('--check-voice-recap')) {
    await page.locator('#replay-speak').click();
    await expectText(page.locator('.message.assistant').last(), /回顾|推理记录/);
    await expectText(page.locator('.message.assistant').last(), /封住|封路|封闭/);
    pass('实验语音回顾提及实际问过的问题；不保证逐字播报');
  }
  await page.locator('#replay-close').click();
  await page.screenshot({ path: join(output, 'desktop-won.png'), fullPage: true });
  await page.locator('#compact').click(); await page.setViewportSize({ width: 400, height: 740 });
  await page.screenshot({ path: join(output, 'compact-won.png') });
  await page.locator('#open-replay').click(); await page.screenshot({ path: join(output, 'compact-replay.png') }); await page.locator('#replay-close').click();
  await page.locator('#compact').click(); await page.setViewportSize({ width: 1360, height: 1000 });
  pass('回程题 85 分、实际问题回放与无剧透 PNG');
  await page.locator('#next').click(); await expect(page.locator('#case-title')).toHaveText('关灯才看清的通知', { timeout: 45000 });
  await expect(page.locator('#case-status')).toHaveText('正在推理', { timeout: 45000 });
  if (!controllerOnly) await expectText(page.locator('.message.assistant').last(), '关灯才看清的通知');
  await page.locator('#open-replay').click(); await expectText(page.locator('#replay-title'), '回不去的三句话'); await page.locator('#replay-next').click();
  await ask('她和通知之间有玻璃吗？', '是的。');
  await page.locator('#hint').click();
  if (!controllerOnly) await expectText(page.locator('.message.assistant').last(), '影像');
  await expect(page.locator('#hints')).toHaveText('1', { timeout: 15000 });
  if (!latestGame.history.at(-1).text.includes('影像')) throw new Error('服务端未跳过玻璃方向提示');
  await ask('我的答案是她换了一副眼镜，所以纸上的字就能看清了。', '还');
  await expect(page.locator('#case-status')).toHaveText('正在推理');
  await answer('隔着玻璃门看通知时，身后房间的灯使玻璃映出室内倒影。关掉这一侧的灯后反光减弱，走廊灯还亮着，所以能透过玻璃看清通知。', 80);
  pass('通知题：上一局回放、提示跳级、错误因果拒绝、80 分结算');
  await page.locator('#library-launcher').click(); await page.locator('[data-case-id="orange-radio"]').click();
  await expect(page.locator('#case-title')).toHaveText('只认橘子的电台', { timeout: 45000 });
  await expect(page.locator('#case-status')).toHaveText('正在推理', { timeout: 45000 });
  if (!controllerOnly) await expectText(page.locator('.message.assistant').last(), '只认橘子的电台');
  await ask('第一句是提前录好的音频吗？', '是的。');
  await ask('橘子是永久固定口令吗？', '不是。');
  await ask('第一轮对面当时其实完全没有听到吗？', /无法确定|未知/);
  await ask('对面的发声者是一位中年男性吗？', /无法确定|未知/);
  await ask('我的答案是第一句是录音，而橘子是永久固定密码，所以一听到橘子就永远允许通过。', '还');
  await expect(page.locator('#case-status')).toHaveText('正在推理');
  await answer('预先录好的固定句子不能证明收到了当前消息。小矽在这一轮临时选了词，对面收到后准确复述，说明本轮消息实时往返，不是认永久密码。', 95);
  pass('电台题：不是永久密码、不把未证明当作事实、错误答案拒绝、95 分结算');
  if (errors.length) throw new Error('浏览器脚本错误');
  await page.locator('#wake').click(); await expect(page.locator('#connection')).toContainText('等待唤醒'); pass('休眠关闭音频并断开');
} catch (error) {
  console.error('新题真实验收未完成：' + error.message); checks.push({ name: 'current-step', passed: false, errorKind: error.name }); process.exitCode = 1;
  await page?.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
} finally {
  await browser?.close(); rmSync(temp, { recursive: true, force: true });
  writeFileSync(join(output, 'report.json'), JSON.stringify({ scope: controllerOnly ? 'controller-flow-only' : 'controller-and-spoken-checks', spokenSemanticCertified: false, checks, results, rounds, speechDeviations, errors, voiceRecapRequested: process.argv.includes('--check-voice-recap'), prerecordedMicrophone: true, physicalMicrophoneUsed: false, speakerMuted: true }, null, 2));
  console.log(`本机验收记录：${output}`);
}
