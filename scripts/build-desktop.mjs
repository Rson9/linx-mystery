import { packager } from '@electron/packager';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
if (process.platform !== 'darwin') throw new Error('此命令在 macOS 上构建本机架构的桌面应用');
const stage = mkdtempSync(join(tmpdir(), 'misheng-app-'));
try {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  for (const dir of ['src', 'public', 'desktop']) cpSync(join(root, dir), join(stage, dir), { recursive: true });
  for (const file of ['package.json', 'pnpm-lock.yaml']) cpSync(join(root, file), join(stage, file));
  // Only explicit source directories are staged. Configuration, identity, records and browser profiles are never copied.
  execFileSync('pnpm', ['install', '--prod', '--frozen-lockfile', '--ignore-scripts', '--node-linker=hoisted'], { cwd: stage, stdio: 'inherit' });
  const require = createRequire(import.meta.url), electronVersion = require('electron/package.json').version;
  const icon = join(root, 'desktop/icon.icns');
  const paths = await packager({ dir: stage, out: join(root, 'dist'), name: '谜声', executableName: 'MISHENG',
    appBundleId: 'io.misheng.desktop', appVersion: manifest.version, platform: 'darwin', arch: process.arch,
    electronVersion, asar: true, prune: false, overwrite: true, ...(existsSync(icon) ? { icon: [icon] } : {}),
    extendInfo: { NSMicrophoneUsageDescription: '小矽仅在你点击说话后使用麦克风，将语音发送到已绑定的灵矽 Agent。',
      NSAppTransportSecurity: { NSAllowsLocalNetworking: true }, LSApplicationCategoryType: 'public.app-category.games' }
  });
  const appPath = paths[0].endsWith('.app') ? paths[0] : join(paths[0], '谜声.app'), entitlements = join(stage, 'microphone.plist');
  writeFileSync(entitlements, '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/><key>com.apple.security.device.audio-input</key><true/></dict></plist>');
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--entitlements', entitlements, appPath], { stdio: 'inherit' });
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
  const zip = join(root, 'dist', `MISHENG-${manifest.version}-mac-${process.arch}.zip`);
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, zip]);
  writeFileSync(`${zip}.sha256`, `${createHash('sha256').update(readFileSync(zip)).digest('hex')}  MISHENG-${manifest.version}-mac-${process.arch}.zip\n`);
  console.log(`桌面应用：${appPath}\n分发包：${zip}\n本地 ad-hoc 签名已核对；未包含个人配置或设备身份。`);
} finally { rmSync(stage, { recursive: true, force: true }); }
