import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const gamePort = Number(process.env.PORT || 3210), petPort = Number(process.env.PET_PORT || 3212);
for (const port of [gamePort, petPort]) if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT / PET_PORT 需要是 1024–65535 的端口');
const gameOrigin = process.env.PET_GAME_ORIGIN || `http://127.0.0.1:${gamePort}`;
const petUrl = `http://127.0.0.1:${petPort}`;
const children = new Set(); let stopping = false;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const probe = async (url, predicate) => {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(1000) }); return r.ok && predicate(await r.json()); } catch { return false; }
};
const stop = () => { stopping = true; for (const child of children) child.kill('SIGTERM'); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
function start(file) {
  const child = spawn(process.execPath, ['--env-file-if-exists=.env', file], { cwd: root, stdio: 'inherit', env: process.env });
  children.add(child);
  child.once('error', () => { console.error('终端启动失败，请检查端口和 Node 环境。'); process.exitCode = 1; stop(); });
  child.once('exit', code => { children.delete(child); if (!stopping) { console.error(`终端进程已退出（${code ?? 'signal'}）。`); process.exitCode = 1; stop(); } });
}
async function wait(url, predicate) {
  for (let i = 0; i < 35 && !stopping; i++) { if (await probe(url, predicate)) return; await sleep(300); }
  throw new Error('服务未就绪，请检查端口、.env 和上方错误。');
}
function openWindow() {
  const url = `${petUrl}/?compact=1`;
  if (process.platform === 'darwin') {
    const profile = resolve(root, '.local/pet-browser'); mkdirSync(profile, { recursive: true, mode: 0o700 });
    const child = spawn('open', ['-na', 'Google Chrome', '--args', `--user-data-dir=${profile}`, `--app=${url}`, '--window-size=400,740', '--no-first-run'], { stdio: 'ignore' });
    child.on('error', () => console.log(`请在 Chrome 中打开 ${url}`));
    child.once('exit', code => { if (code) console.log(`自动打开失败，请在 Chrome 中访问 ${url}`); });
  } else console.log(`请在 Chrome 中打开 ${url}`);
}
try {
  const petReady = () => probe(`${petUrl}/healthz`, d => d.service === 'misheng-pet');
  if (process.argv.includes('open')) {
    if (!await petReady()) throw new Error('先运行 pnpm pet，再运行 pnpm pet:open。');
    openWindow();
  } else if (await petReady()) {
    console.log(`桌宠已经在线：${petUrl}`); if (!process.argv.includes('--no-open')) openWindow();
  } else {
    const gameReady = d => Array.isArray(d.cases) && d.cases.length > 0;
    if (!await probe(new URL('/api/catalog', gameOrigin), gameReady)) {
      if (new URL(gameOrigin).hostname !== '127.0.0.1') throw new Error('配置的游戏服务离线，请先启动该服务。');
      console.log('正在启动游戏引擎…'); start(resolve(root, 'src/server.js')); await wait(new URL('/api/catalog', gameOrigin), gameReady);
    } else console.log('复用已有游戏引擎，不会在关闭桌宠时停止它。');
    start(resolve(root, 'src/pet-server.js')); await wait(`${petUrl}/healthz`, d => d.service === 'misheng-pet');
    console.log(`\n小矽已经就绪：${petUrl}\n点击“唤醒并开始”，即可听题、提问、提示和作答。麦克风需要你手动开启。`);
    if (!process.argv.includes('--no-open')) openWindow();
  }
} catch (error) { console.error(error.message); process.exitCode = 1; stop(); }
