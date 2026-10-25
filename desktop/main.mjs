import { app, BrowserWindow, Menu, Tray, ipcMain, screen, shell, dialog, nativeImage } from 'electron';
import { readFileSync, mkdirSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { loadLocalKey, authenticateLocalService, validServiceProof, NONCE_HEADER, PROOF_HEADER } from '../src/local-service-auth.js';
import { PET_SIZE, ACTIONS, trustedPage, audioPermission, normalizeRects, hitTest, keepOnScreen } from './policy.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const testing = process.env.MISHENG_DESKTOP_TEST === '1';
app.setName('谜声');
app.setPath('userData', join(app.getPath('appData'), 'MISHENG'));
if (testing && process.env.MISHENG_DESKTOP_TEST_DIR) app.setPath('userData', resolve(process.env.MISHENG_DESKTOP_TEST_DIR));
if (testing) for (const flag of ['use-fake-device-for-media-stream', 'use-fake-ui-for-media-stream', 'mute-audio']) app.commandLine.appendSwitch(flag);
const locked = app.requestSingleInstanceLock();
let win, tray, timer, quit = false, expanded = false, drag = null, rects = [], lastIgnored = null;
let collapsed, prefs = {}, runtimeRoot, uiState = { ready: false, recording: false };
const owned = [];
const settingsPath = join(app.getPath('userData'), 'desktop.json');
const savePrefs = () => {
  try {
    mkdirSync(dirname(settingsPath), { recursive: true, mode: 0o700 });
    writeFileSync(`${settingsPath}.tmp`, JSON.stringify(prefs), { mode: 0o600 }); renameSync(`${settingsPath}.tmp`, settingsPath);
  } catch { /* A read-only preference directory must not interrupt speech. */ }
};
let origin, localKey;
// Deterministic pointer injection is confined to the isolated, fake-media test runtime.
const cursorPoint = () => testing && Number.isFinite(process.__mishengTestPointer?.x) && Number.isFinite(process.__mishengTestPointer?.y) ? process.__mishengTestPointer : screen.getCursorScreenPoint();
const trusted = event => win && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame && trustedPage(event.senderFrame.url, origin);
function perform(action) { if (win && ACTIONS.includes(action)) { win.show(); win.webContents.send('pet:action', action); } }
function menuTemplate() {
  return [
    { label: '小矽 · 谜声', enabled: false },
    { label: expanded ? '收起推理台' : '展开推理台', click: () => perform('board') },
    { label: '选个故事', click: () => perform('library') },
    { label: '查看推理回放', click: () => perform('replay') },
    { type: 'separator' },
    { label: uiState.ready ? '让小矽休眠' : '唤醒并开始', enabled: !uiState.recording, click: () => perform('wake') },
    { label: '停止当前回复', enabled: uiState.ready, click: () => perform('interrupt') },
    { label: '切换静音', click: () => perform('mute') },
    { label: '保持置顶', type: 'checkbox', checked: prefs.onTop !== false, click: item => { prefs.onTop = item.checked; win?.setAlwaysOnTop(item.checked, 'floating'); savePrefs(); } },
    { label: '重置桌宠位置', click: () => resetPosition() },
    { type: 'separator' },
    { label: '选择配置目录…', click: async () => {
      const result = await dialog.showOpenDialog(win, { title: '选择包含 .env 和 .local 的谜声目录', properties: ['openDirectory'] });
      if (!result.canceled && result.filePaths[0]) { prefs.runtimeRoot = result.filePaths[0]; savePrefs(); app.relaunch(); app.quit(); }
    } },
    { label: '打开配置目录', click: () => shell.openPath(runtimeRoot) },
    { label: '退出小矽', click: () => app.quit() }
  ];
}
function resetPosition() {
  if (!win) return;
  const area = screen.getPrimaryDisplay().workArea;
  collapsed = keepOnScreen({ ...PET_SIZE, x: area.x + area.width - PET_SIZE.width - 24, y: area.y + area.height - PET_SIZE.height - 24 }, area);
  prefs.position = { x: collapsed.x, y: collapsed.y }; savePrefs();
  if (!expanded) win.setBounds(collapsed); win.show();
}
function setExpanded(value) {
  if (!win || value === expanded) return;
  if (drag) { drag = null; win.webContents.send('pet:dragged', false); }
  if (value) {
    collapsed = win.getBounds(); const area = screen.getDisplayMatching(collapsed).workArea;
    const width = Math.min(1160, area.width - 32), height = Math.min(900, area.height - 32);
    win.setIgnoreMouseEvents(false); lastIgnored = false;
    win.setBounds({ width, height, x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + (area.height - height) / 2) });
  } else {
    const area = screen.getDisplayMatching(collapsed).workArea; collapsed = keepOnScreen(collapsed, area); win.setBounds(collapsed);
  }
  expanded = value;
}
async function ensureServices() {
  const petPort = Number(process.env.PET_PORT || 3212), gamePort = Number(process.env.PORT || 3210);
  for (const port of [petPort, gamePort]) if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('端口配置无效');
  origin = `http://127.0.0.1:${petPort}`;
  const probe = async (url, check) => { try { const r = await fetch(url, { signal: AbortSignal.timeout(1200) }); return r.ok && check(await r.json()); } catch { return false; } };
  const gameOrigin = process.env.PET_GAME_ORIGIN || `http://127.0.0.1:${gamePort}`;
  if (await probe(`${origin}/healthz`, data => data.service === 'misheng-pet')) {
    if (!await authenticateLocalService(origin, 'pet', localKey)) throw new Error('本机桌面服务未通过认证，请停止旧服务再启动');
    if (new URL(gameOrigin).protocol === 'http:' && !await authenticateLocalService(gameOrigin, 'engine', localKey)) throw new Error('本机游戏服务未通过认证，请停止旧服务再启动');
    return;
  }
  const gameOnline = await probe(new URL('/api/catalog', gameOrigin), data => Array.isArray(data.cases));
  if (gameOnline && new URL(gameOrigin).protocol === 'http:' && !await authenticateLocalService(gameOrigin, 'engine', localKey)) throw new Error('本机游戏服务未通过认证，请停止旧服务再启动');
  if (!gameOnline) {
    if (new URL(gameOrigin).hostname !== '127.0.0.1') throw new Error('配置的游戏服务未启动');
    const { createApp } = await import('../src/server.js'); const runtime = createApp();
    const server = await new Promise((done, reject) => { const s = runtime.app.listen(gamePort, '127.0.0.1', () => done(s)); s.once('error', reject); });
    owned.push(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); await runtime.close(); });
  }
  const { createPetServer } = await import('../src/pet-server.js'); const pet = createPetServer();
  await new Promise((done, reject) => { pet.server.once('error', reject); pet.server.listen(petPort, '127.0.0.1', done); });
  owned.push(() => pet.close());
}
async function boot() {
  try { prefs = JSON.parse(readFileSync(settingsPath, 'utf8')); } catch { prefs = {}; }
  if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) prefs = {};
  if (!Number.isFinite(prefs.position?.x) || !Number.isFinite(prefs.position?.y)) delete prefs.position;
  const configSwitch = app.commandLine.getSwitchValue('config-dir');
  runtimeRoot = resolve(testing ? app.getPath('userData') : configSwitch || process.env.MISHENG_HOME || prefs.runtimeRoot || (app.isPackaged ? app.getPath('userData') : root));
  if (!existsSync(runtimeRoot) && runtimeRoot !== app.getPath('userData')) throw new Error('配置目录不存在，请重新选择');
  mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  if (!testing && existsSync(join(runtimeRoot, '.env'))) process.loadEnvFile(join(runtimeRoot, '.env'));
  process.env.MISHENG_HOME = runtimeRoot;
  localKey = loadLocalKey(runtimeRoot);
  process.env.DB_PATH = process.env.DB_PATH === ':memory:' ? ':memory:' : resolve(runtimeRoot, process.env.DB_PATH || 'data/games.sqlite');
  if (!testing && configSwitch) { prefs.runtimeRoot = runtimeRoot; savePrefs(); }
  await ensureServices();
  const area = screen.getPrimaryDisplay().workArea;
  collapsed = keepOnScreen({ ...PET_SIZE, x: Number.isFinite(prefs.position?.x) ? prefs.position.x : area.x + area.width - 344, y: Number.isFinite(prefs.position?.y) ? prefs.position.y : area.y + area.height - 424 }, area);
  // Recover windows after monitor removal, without pulling a valid secondary-monitor position away.
  collapsed = keepOnScreen({ ...collapsed, ...prefs.position, ...PET_SIZE }, screen.getDisplayMatching({ ...collapsed, ...prefs.position, ...PET_SIZE }).workArea);
  win = new BrowserWindow({ ...collapsed, title: '小矽 · 谜声', transparent: true, backgroundColor: '#00000000', frame: false, hasShadow: false,
    resizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, show: false,
    webPreferences: { preload: join(root, 'desktop/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, backgroundThrottling: false, autoplayPolicy: 'user-gesture-required' }
  });
  win.setAlwaysOnTop(prefs.onTop !== false, 'floating');
  if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  const ses = win.webContents.session;
  const pendingProofs = new Map(), proofFilter = { urls: [`${origin}/*`, `${origin.replace('http:', 'ws:')}/*`] };
  // Authenticate documents, scripts, assets and WebSocket upgrades, not just the initial health response.
  ses.webRequest.onBeforeSendHeaders(proofFilter, (details, callback) => {
    if (pendingProofs.size >= 512) { callback({ cancel: true }); return; }
    const nonce = randomBytes(32).toString('hex'); pendingProofs.set(details.id, nonce);
    callback({ requestHeaders: { ...details.requestHeaders, [NONCE_HEADER]: nonce } });
  });
  ses.webRequest.onHeadersReceived(proofFilter, (details, callback) => {
    const proof = Object.entries(details.responseHeaders || {}).find(([name]) => name.toLowerCase() === PROOF_HEADER.toLowerCase())?.[1]?.[0];
    const nonce = pendingProofs.get(details.id);
    callback({ cancel: !validServiceProof(localKey, 'pet', Number(new URL(origin).port), nonce, proof) });
  });
  ses.webRequest.onCompleted(proofFilter, details => pendingProofs.delete(details.id));
  ses.webRequest.onErrorOccurred(proofFilter, details => pendingProofs.delete(details.id));
  ses.setPermissionRequestHandler((contents, permission, callback, details) => callback(contents === win?.webContents && details.isMainFrame && audioPermission(permission, details, origin)));
  ses.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => contents === win?.webContents && permission === 'media'
    && trustedPage(requestingOrigin, origin) && details?.mediaType === 'audio');
  ses.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url === 'https://xrobo.qiniu.com/') void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => { if (!trustedPage(url, origin)) event.preventDefault(); });
  win.webContents.on('will-attach-webview', event => event.preventDefault());
  win.webContents.on('render-process-gone', () => app.quit());
  ses.on('will-download', (event, item) => {
    if (!item.getURL().startsWith(`blob:${origin}/`)) { event.preventDefault(); return; }
    const name = item.getFilename().replace(/[\\/\x00-\x1f]/g, '_');
    item.setSaveDialogOptions({ defaultPath: join(app.getPath('downloads'), name), filters: [{ name: 'PNG', extensions: ['png'] }] });
  });
  ipcMain.handle('pet:expanded', (event, value) => { if (trusted(event) && typeof value === 'boolean') setExpanded(value); return expanded; });
  ipcMain.on('pet:hit-areas', (event, value) => { if (trusted(event)) {
    const size = win.getContentBounds(); rects = normalizeRects(value, size.width, size.height);
    if (rects.length && !win.isVisible()) { win.show(); if (process.platform === 'darwin' && !testing) app.dock?.hide(); }
  } });
  ipcMain.on('pet:state', (event, state) => { if (trusted(event)) uiState = { ready: state?.ready === true, recording: state?.recording === true }; });
  ipcMain.on('pet:menu', event => { if (trusted(event)) Menu.buildFromTemplate(menuTemplate()).popup({ window: win }); });
  ipcMain.on('pet:drag', (event, phase) => {
    if (!trusted(event) || expanded) return;
    if (phase === 'start') drag = { point: { ...cursorPoint() }, last: { ...cursorPoint() }, bounds: win.getBounds(), moved: false };
    else if (phase === 'stop' && drag) endDrag();
  });
  function endDrag() {
    const moved = drag?.moved; drag = null;
    if (moved) { collapsed = win.getBounds(); prefs.position = { x: collapsed.x, y: collapsed.y }; savePrefs(); }
    win.webContents.send('pet:dragged', Boolean(moved));
  }
  timer = setInterval(() => {
    if (!win || win.isDestroyed()) return;
    const point = cursorPoint();
    if (drag) {
      const dx = point.x - drag.point.x, dy = point.y - drag.point.y;
      if (Math.hypot(dx, dy) > 4) {
        const direction = point.x === drag.last.x ? drag.direction || 'right' : point.x < drag.last.x ? 'left' : 'right';
        if (!drag.moved || drag.direction !== direction) { drag.moved = true; drag.direction = direction; win.webContents.send('pet:dragged', true, direction); }
        const proposed = { ...drag.bounds, x: drag.bounds.x + dx, y: drag.bounds.y + dy };
        win.setBounds(keepOnScreen(proposed, screen.getDisplayNearestPoint(point).workArea));
      }
      drag.last = { ...point };
    }
    const ignore = !expanded && !drag && !hitTest(point, win.getBounds(), rects);
    if (ignore !== lastIgnored) { win.setIgnoreMouseEvents(ignore, { forward: true }); lastIgnored = ignore; }
  }, 25);
  const traySvg = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18"><rect x="2" y="4" width="14" height="12" rx="5" fill="black"/><path d="M9 1v3" stroke="black" stroke-width="2"/><circle cx="6" cy="9" r="1" fill="white"/><circle cx="12" cy="9" r="1" fill="white"/><path d="M6 12q3 3 6 0" fill="none" stroke="white"/></svg>';
  const icon = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(traySvg).toString('base64')}`);
  icon.setTemplateImage(true); tray = new Tray(icon); if (icon.isEmpty() && process.platform === 'darwin') tray.setTitle('◒');
  tray.setToolTip('小矽 · 谜声'); tray.on('click', () => Menu.buildFromTemplate(menuTemplate()).popup()); tray.on('right-click', () => Menu.buildFromTemplate(menuTemplate()).popup());
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: '谜声', submenu: [{ role: 'about' }, ...menuTemplate()] }, { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] }]));
  win.on('blur', () => { if (drag) endDrag(); });
  win.on('closed', () => { win = null; app.quit(); });
  screen.on('display-removed', () => {
    if (!win) return;
    const current = win.getBounds(), area = screen.getDisplayMatching(current).workArea;
    win.setBounds(keepOnScreen(current, area));
    const collapsedArea = screen.getDisplayMatching(collapsed).workArea; collapsed = keepOnScreen(collapsed, collapsedArea);
    prefs.position = { x: collapsed.x, y: collapsed.y }; savePrefs();
  });
  await win.loadURL(`${origin}/?desktop=1`);
}
if (!locked) app.quit();
else {
  app.on('second-instance', () => win?.show());
  app.on('activate', () => win?.show());
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (quit) return; event.preventDefault(); quit = true; clearInterval(timer); tray?.destroy();
    Promise.allSettled(owned.reverse().map(close => close())).finally(() => app.quit());
  });
  app.whenReady().then(boot).catch(error => {
    console.error('桌宠启动失败：', error.code || error.name);
    if (!testing) dialog.showErrorBox('小矽暂时无法启动', '请检查端口、配置目录与运行环境。已有设备身份不需要重新创建。');
    app.exit(1);
  });
}
