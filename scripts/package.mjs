import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
export function createSourcePackage(root = projectRoot) {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (realpathSync(git(['rev-parse', '--show-toplevel'])) !== realpathSync(root)) throw new Error('请在项目 Git 根目录打包');
  if (git(['status', '--porcelain', '--untracked-files=normal'])) throw new Error('存在未提交变更，请先提交后再生成交付包');
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version || '')) throw new Error('软件版本号无效');
  const paths = git(['ls-files', '-z']).split('\0').filter(Boolean);
  const forbidden = paths.filter(p => /(^|\/)\.env(?:\..*)?$/.test(p) && !p.endsWith('.env.example')
    || /^(?:\.local|\.secrets|data|node_modules|\.venv(?:-lingxi)?|eval-results|test-results|playwright-report|dist)\//.test(p)
    || /(?:\.sqlite(?:-wal|-shm)?|\.pyc|\.log)$/.test(p) || p.split('/').includes('__pycache__'));
  if (forbidden.length) throw new Error(`运行配置或数据不能进入交付包：${forbidden.join(', ')}`);
  const output = join(root, 'dist'); mkdirSync(output, { recursive: true });
  const file = join(output, `linx-mystery-${version}.zip`);
  git(['archive', '--format=zip', `--prefix=linx-mystery-${version}/`, `--output=${file}`, 'HEAD']);
  const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex');
  writeFileSync(`${file}.sha256`, `${sha256}  ${basename(file)}\n`);
  return { file, sha256, version, commit: git(['rev-parse', '--short', 'HEAD']) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = createSourcePackage();
    console.log(`交付包：${result.file}\nSHA-256：${result.sha256}\n版本：${result.version} · 提交：${result.commit}`);
  } catch (error) { console.error(`打包失败：${error.message}`); process.exitCode = 1; }
}
