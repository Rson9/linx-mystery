import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const clientDir = resolve(root, 'clients/lingxi');
const run = (command, args, cwd = root) => {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error) { console.error(`无法运行 ${command}：${result.error.message}。Python 环境需要先安装 uv。`); process.exit(1); }
  if (result.status !== 0) process.exit(result.status ?? 1);
};
const python = (args, cwd = root) => run('uv', ['run', '--project', root, '--locked', 'python', ...args], cwd);
const [mode, ...extra] = process.argv.slice(2);
if (!['setup', 'activate', 'check', 'probe', 'smoke', 'playtest', 'start', 'test'].includes(mode)) {
  console.error('用法：node scripts/voice.mjs setup|activate|check|probe|smoke|playtest|start|test'); process.exit(1);
}
if (mode === 'test') {
  python(['-m', 'unittest', 'discover', '-s', resolve(clientDir, 'tests'), '-v']);
} else if (mode === 'setup') {
  run('uv', ['sync', '--project', root, '--locked']);
  python(['-c', 'from codec import OpusCodec; c=OpusCodec(); c.close(); print("语音依赖已就绪。下一步：pnpm voice:activate")'], clientDir);
} else {
  python([resolve(clientDir, 'client.py'), ...(mode === 'start' ? [] : [`--${mode}`]), ...extra]);
}
