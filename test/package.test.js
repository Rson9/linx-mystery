import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSourcePackage } from '../scripts/package.mjs';

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'misheng-package-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = args => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd: root, stdio: 'pipe' });
  git(['init', '-q']); git(['config', 'user.name', 'Package Test']); git(['config', 'user.email', 'package@example.invalid']);
  writeFileSync(join(root, '.gitignore'), 'dist/\n.env\n.local/\ndata/\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'linx-mystery', version: '0.2.0' }));
  writeFileSync(join(root, 'README.md'), '# package fixture\n');
  writeFileSync(join(root, '.env.example'), 'TOKEN=\n');
  git(['add', '-f', '.gitignore', 'package.json', 'README.md', '.env.example']); git(['commit', '-qm', 'fixture']);
  return { root, git };
}
function zipNames(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])); assert.ok(end >= 0);
  const count = buffer.readUInt16LE(end + 10), names = []; let at = buffer.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    assert.equal(buffer.readUInt32LE(at), 0x02014b50);
    const length = buffer.readUInt16LE(at + 28), extra = buffer.readUInt16LE(at + 30), comment = buffer.readUInt16LE(at + 32);
    names.push(buffer.subarray(at + 46, at + 46 + length).toString('utf8')); at += 46 + length + extra + comment;
  }
  return names;
}
test('源码包只取干净提交，忽略本机配置和身份，生成可核对且可复现的 ZIP', t => {
  const { root } = setup(t);
  writeFileSync(join(root, '.env'), 'LOCAL_ONLY=fixture\n'); mkdirSync(join(root, '.local'));
  writeFileSync(join(root, '.local/device.json'), 'local identity');
  const result = createSourcePackage(root), bytes = readFileSync(result.file), names = zipNames(bytes);
  assert.ok(names.includes('linx-mystery-0.2.0/README.md')); assert.ok(names.includes('linx-mystery-0.2.0/.env.example'));
  assert.equal(names.some(n => n.endsWith('/.env') || n.includes('/.local/') || n.includes('/.git/')), false);
  assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.ok(readFileSync(`${result.file}.sha256`, 'utf8').startsWith(result.sha256));
  assert.deepEqual(readFileSync(createSourcePackage(root).file), bytes);
});
test('存在未提交变更时拒绝打包，不把工作区与旧提交混作同一版本', t => {
  const { root } = setup(t); writeFileSync(join(root, 'README.md'), 'changed');
  assert.throws(() => createSourcePackage(root), /未提交变更/); assert.equal(existsSync(join(root, 'dist')), false);
});
test('被误跟踪的配置、身份和数据库不能进入交付包', t => {
  for (const path of ['.env', '.local/device.json', 'data/games.sqlite']) {
    const { root, git } = setup(t); const parts = path.split('/');
    if (parts.length > 1) mkdirSync(join(root, parts[0]), { recursive: true });
    writeFileSync(join(root, path), 'fixture runtime data'); git(['add', '-f', path]); git(['commit', '-qm', 'runtime fixture']);
    assert.throws(() => createSourcePackage(root), /运行配置或数据/); assert.equal(existsSync(join(root, 'dist')), false);
  }
});
