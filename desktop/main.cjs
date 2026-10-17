// Agent Hub desktop app (Electron): runs the hub in the background, with no console window, and shows the
// dashboard in its own window. Closing the window keeps the hub running in the tray; Quit stops it.
//
//   data          <user data>/hub          agents, user database, pictures (private)
//   chat history  <Documents>/Agent Hub    every message as Markdown and JSON lines, readable and kept
const { app, BrowserWindow, Tray, Menu, shell, nativeImage, Notification, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const { fork } = require('node:child_process');

const HUB_DIR = app.isPackaged ? path.join(process.resourcesPath, 'hub') : path.join(__dirname, '..');
const ICON = path.join(__dirname, 'build', 'icon.png');
const TRAY_ICON = path.join(__dirname, 'build', process.platform === 'win32' ? 'tray.ico' : 'tray.png');

let win = null;
let tray = null;
let hub = null; // the hub's child process (null when attached to a hub that was already running)
let hubUrl = null;
let attached = false;
let quitting = false;
let restarts = [];
let toldAboutTray = false;

// ---------- settings ----------
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function readSettings() {
  try { return { port: 7700, network: false, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; } catch { return { port: 7700, network: false }; }
}
function writeSettings(s) {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
}
const dataDir = () => path.join(app.getPath('userData'), 'hub');
const historyDir = () => path.join(app.getPath('documents'), 'Agent Hub');
const logFile = () => path.join(app.getPath('userData'), 'logs', 'hub.log');
function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) return a.address;
  }
  return '127.0.0.1';
}

// ---------- the hub in the background ----------
async function isHub(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(800) });
    return r.ok && (await r.json()).ok === true;
  } catch { return false; }
}
const portFree = (port) => new Promise((resolve) => {
  const srv = net.createServer().once('error', () => resolve(false)).once('listening', () => srv.close(() => resolve(true)));
  srv.listen(port, '0.0.0.0');
});
async function startHub() {
  const settings = readSettings();
  // a hub already running here (from the command line, say): use it rather than start a second one
  if (await isHub(settings.port)) {
    attached = true;
    hubUrl = `http://127.0.0.1:${settings.port}`;
    return;
  }
  let port = settings.port;
  while (!(await portFree(port)) && port < settings.port + 20) port++;
  fs.mkdirSync(path.dirname(logFile()), { recursive: true });
  const log = fs.createWriteStream(logFile(), { flags: 'a' });
  log.write(`\n[${new Date().toISOString()}] starting the hub on port ${port}${settings.network ? ' (shared on the local network)' : ''}\n`);
  const args = ['--port', String(port), '--data', dataDir(), '--history', historyDir()];
  if (settings.network) args.push('--host', '0.0.0.0', '--public-url', `http://${lanAddress()}:${port}`);
  // Electron's own Node runs the hub: no console window, no separate Node.js install
  hub = fork(path.join(HUB_DIR, 'server.mjs'), args, {
    execPath: process.execPath,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  hub.stdout.pipe(log, { end: false });
  hub.stderr.pipe(log, { end: false });
  hub.on('exit', (code) => {
    log.write(`[${new Date().toISOString()}] the hub stopped (exit ${code})\n`);
    hub = null;
    if (quitting) return;
    // restart it, unless it keeps failing
    const now = Date.now();
    restarts = restarts.filter((t) => now - t < 60_000).concat(now);
    if (restarts.length > 4) {
      dialog.showErrorBox('Agent Hub stopped', `The hub stopped several times in a row. Its log is in:\n${logFile()}`);
      return;
    }
    setTimeout(() => startHub().then(() => win?.reload()).catch(() => {}), 1500);
  });
  hubUrl = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 75; i++) {
    if (await isHub(port)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`the hub did not start: see ${logFile()}`);
}
function stopHub() {
  return new Promise((resolve) => {
    if (!hub) return resolve();
    const child = hub;
    const timer = setTimeout(() => { child.kill(); resolve(); }, 4000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    try { child.send('shutdown'); } catch { child.kill(); }
  });
}

// ---------- the window ----------
function createWindow({ show = true } = {}) {
  win = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    title: 'Agent Hub',
    icon: ICON,
    backgroundColor: '#0b1120',
    autoHideMenuBar: true,
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.removeMenu();
  win.loadURL(hubUrl + '/');
  win.once('ready-to-show', () => show && win.show());
  // links leave the app for the browser; the window only shows the hub
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(hubUrl)) {
      e.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    if (!toldAboutTray && Notification.isSupported()) {
      toldAboutTray = true;
      new Notification({ title: 'Agent Hub is still running', body: 'Your agents can keep talking. Open it again, or quit, from the tray icon.', icon: ICON }).show();
    }
  });
}
function showWindow() {
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// ---------- the tray ----------
function buildTray() {
  const settings = readSettings();
  const login = app.getLoginItemSettings();
  const menu = Menu.buildFromTemplate([
    { label: 'Open Agent Hub', click: showWindow },
    { label: 'Open in browser', click: () => shell.openExternal(hubUrl + '/') },
    { type: 'separator' },
    {
      label: 'Share on local network',
      type: 'checkbox',
      checked: !!settings.network,
      enabled: !attached,
      click: async (item) => {
        writeSettings({ ...readSettings(), network: item.checked });
        await stopHub();
        await startHub();
        win?.reload();
        buildTray();
        if (item.checked) {
          dialog.showMessageBox({ type: 'info', title: 'Shared on your network', message: `Agents on your network can now reach the hub at\nhttp://${lanAddress()}:${new URL(hubUrl).port}`, detail: 'If Windows asks, allow Agent Hub on private networks only. Use this on networks you trust: the hub speaks plain HTTP.' });
        }
      },
    },
    { label: 'Open chat history folder', click: () => { fs.mkdirSync(historyDir(), { recursive: true }); shell.openPath(historyDir()); } },
    { label: 'Open data folder', click: () => shell.openPath(attached ? app.getPath('userData') : dataDir()) },
    { type: 'separator' },
    {
      label: 'Start when I sign in',
      type: 'checkbox',
      checked: login.openAtLogin,
      click: (item) => { app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] }); buildTray(); },
    },
    { type: 'separator' },
    { label: attached ? 'Connected to a hub already running here' : `Running on ${hubUrl.replace('http://', '')}`, enabled: false },
    { label: 'Quit Agent Hub', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(`Agent Hub · ${hubUrl}`);
}

// ---------- start ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.setAppUserModelId('io.github.protik1810.agenthub');
  app.whenReady().then(async () => {
    try {
      await startHub();
    } catch (e) {
      dialog.showErrorBox('Agent Hub could not start', e.message);
      app.exit(1);
      return;
    }
    tray = new Tray(nativeImage.createFromPath(TRAY_ICON));
    tray.on('click', showWindow);
    tray.on('double-click', showWindow);
    buildTray();
    createWindow({ show: !process.argv.includes('--hidden') });
  });
  app.on('window-all-closed', () => {}); // keep running in the tray
  app.on('activate', showWindow);
  app.on('before-quit', (e) => {
    quitting = true;
    // let the hub save and close its database first (its exit handler clears hub, so the second quit goes through)
    if (hub) {
      e.preventDefault();
      stopHub().then(() => app.quit());
    }
  });
}
