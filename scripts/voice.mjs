import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const clientDir = resolve(root, 'clients/lingxi');
const venv = resolve(root, '.venv-lingxi');
const python = resolve(venv, 'bin/python');
const run = (command, args, cwd = root) => {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error) { console.error(`无法运行 ${command}：${result.error.message}`); process.exit(1); }
  if (result.status !== 0) process.exit(result.status ?? 1);
};
const [mode, ...extra] = process.argv.slice(2);
if (!['setup', 'activate', 'check', 'start', 'test'].includes(mode)) {
  console.error('用法：node scripts/voice.mjs setup|activate|check|start|test'); process.exit(1);
}
if (mode === 'test') {
  run(existsSync(python) ? python : 'python3', ['-m', 'unittest', 'discover', '-s', 'tests', '-v'], clientDir);
} else if (mode === 'setup') {
  if (!existsSync(python)) run('python3', ['-m', 'venv', venv]);
  run(python, ['-m', 'pip', 'install', '-r', resolve(clientDir, 'requirements.txt')]);
  run(python, ['-c', 'from codec import OpusCodec; c=OpusCodec(); c.close(); print("语音依赖已就绪。下一步：npm run voice:activate")'], clientDir);
} else {
  // 激活只用 Python 标准库，可先获取绑定码，再安装音频依赖。
  if (mode !== 'activate' && !existsSync(python)) {
    console.error('请先运行 npm run voice:setup'); process.exit(1);
  }
  run(existsSync(python) ? python : 'python3', [resolve(clientDir, 'client.py'), ...(mode === 'start' ? [] : [`--${mode}`]), ...extra]);
}
