// Agent Hub desktop app (Electron): runs the hub in the background, with no console window, and shows the
// dashboard in its own window. Closing the window keeps the hub running in the tray; Quit stops it.
//
//   data          <user data>/hub          agents, user database, pictures (private)
//   chat history  <Documents>/Agent Hub    every message as Markdown and JSON lines, readable and kept
//
// The hub is shared on the local network by default (agents on other machines are the point). On Windows the app
// checks that Windows Firewall lets them in and offers to fix it; Tailscale, when installed, adds a private route
// for your own devices anywhere and, on request, a public https link (Tailscale Funnel).
const { app, BrowserWindow, Tray, Menu, shell, nativeImage, Notification, dialog, clipboard } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const { fork, execFile } = require('node:child_process');

// One data folder on every system: %APPDATA%\Agent Hub on Windows, ~/.config/Agent Hub on Linux
app.setName('Agent Hub');
// (AGENT_HUB_USER_DATA points a test copy elsewhere, so it runs beside the installed app)
app.setPath('userData', process.env.AGENT_HUB_USER_DATA || path.join(app.getPath('appData'), 'Agent Hub'));

const HUB_DIR = app.isPackaged ? path.join(process.resourcesPath, 'hub') : path.join(__dirname, '..');
const ICON = path.join(__dirname, 'build', 'icon.png');
const TRAY_ICON = path.join(__dirname, 'build', process.platform === 'win32' ? 'tray.ico' : 'tray.png');
const WINDOWS = process.platform === 'win32';

let win = null;
let tray = null;
let hub = null; // the hub's child process (null when attached to a hub that was already running)
let hubUrl = null;
let hubPort = null;
let attached = false;
let quitting = false;
let restarts = [];
let toldAboutTray = false;
let tailscale = null; // { cli, dnsName, ip } when Tailscale is installed and connected

// ---------- settings ----------
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const DEFAULTS = { port: 7700, network: true, funnel: false, firewallDeclined: false };
function readSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; } catch { return { ...DEFAULTS }; }
}
function writeSettings(s) {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
}
const dataDir = () => path.join(app.getPath('userData'), 'hub');
const historyDir = () => process.env.AGENT_HUB_HISTORY || path.join(app.getPath('documents'), 'Agent Hub'); // (a test copy can keep its own)
const logFile = () => path.join(app.getPath('userData'), 'logs', 'hub.log');

/** Runs a program and returns { code, out } (never throws). */
const run = (file, args, { timeout = 20_000 } = {}) => new Promise((resolve) => {
  execFile(file, args, { windowsHide: true, timeout }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, out: `${stdout}${stderr}` }));
});
const powershell = (command) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command]);

/** This computer's address on the local network: a real adapter, not Tailscale, a VPN or a virtual switch. */
function lanAddress() {
  const candidates = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      const [x, y] = a.address.split('.').map(Number);
      if (x === 100 && y >= 64 && y <= 127) continue; // Tailscale
      const virtual = /vEthernet|VirtualBox|VMware|Hyper-V|WSL|docker|br-|virbr|veth|Loopback|ZeroTier|Hamachi/i.test(name);
      const privateRange = x === 192 && y === 168 ? 0 : x === 10 ? 1 : x === 172 && y >= 16 && y <= 31 ? 2 : 3;
      candidates.push({ address: a.address, score: (virtual ? 10 : 0) + privateRange });
    }
  }
  return candidates.sort((a, b) => a.score - b.score)[0]?.address ?? null;
}

// ---------- Tailscale: a private route for your own devices, and an optional public link ----------
async function findTailscale() {
  const cli = WINDOWS
    ? [path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Tailscale', 'tailscale.exe')].find((p) => fs.existsSync(p))
    : ['/usr/bin/tailscale', '/usr/local/bin/tailscale', '/usr/sbin/tailscale'].find((p) => fs.existsSync(p));
  if (!cli) return null;
  const { code, out } = await run(cli, ['status', '--json'], { timeout: 8000 });
  if (code !== 0) return null;
  try {
    const s = JSON.parse(out.slice(out.indexOf('{')));
    if (s.BackendState !== 'Running') return null;
    return { cli, dnsName: String(s.Self?.DNSName ?? '').replace(/\.$/, ''), ip: (s.Self?.TailscaleIPs ?? []).find((x) => x.includes('.')) ?? null };
  } catch { return null; }
}
async function setFunnel(on, port) {
  if (!tailscale) return { ok: false, out: 'Tailscale is not installed or not connected.' };
  const r = on ? await run(tailscale.cli, ['funnel', '--bg', String(port)], { timeout: 25_000 }) : await run(tailscale.cli, ['funnel', '--https=443', 'off'], { timeout: 15_000 });
  return { ok: r.code === 0 && !/not enabled|error|denied/i.test(r.out), out: r.out.trim() };
}

// ---------- Windows Firewall: other devices can only connect if it lets Agent Hub in ----------
async function firewallState() {
  if (!WINDOWS) return { ok: true };
  const exe = process.execPath.replace(/'/g, "''");
  const { out } = await powershell(`$r = @(Get-NetFirewallApplicationFilter -Program '${exe}' -ErrorAction SilentlyContinue | Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.Direction -eq 'Inbound' -and $_.Enabled -eq 'True' } | ForEach-Object { [pscustomobject]@{ Action = [string]$_.Action; Profile = [string]$_.Profile } }); ConvertTo-Json -Compress -InputObject $r`);
  let rules = [];
  try { rules = JSON.parse(out.trim() || '[]'); } catch { return { ok: true, unknown: true }; }
  if (!Array.isArray(rules)) rules = [rules];
  const blocked = rules.some((r) => /Block/i.test(r.Action));
  const allowed = rules.some((r) => /Allow/i.test(r.Action) && /Private|Any|Domain/i.test(r.Profile));
  const coversPublic = rules.some((r) => /Allow/i.test(r.Action) && /Public|Any/i.test(r.Profile));
  return { ok: allowed && !blocked, blocked, allowed, coversPublic };
}
/** Asks Windows (with the usual administrator prompt) to let Agent Hub accept connections on private networks. */
async function fixFirewall() {
  const exe = process.execPath;
  const script = path.join(app.getPath('userData'), 'allow-agent-hub.cmd');
  fs.writeFileSync(script, [
    '@echo off',
    'rem Lets Agent Hub accept connections from other devices: private and work networks, and Tailscale.',
    `powershell -NoProfile -Command "Get-NetFirewallApplicationFilter -Program '${exe.replace(/'/g, "''")}' -ErrorAction SilentlyContinue | Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.Direction -eq 'Inbound' } | Remove-NetFirewallRule"`,
    `netsh advfirewall firewall add rule name="Agent Hub" dir=in action=allow program="${exe}" enable=yes profile=private,domain`,
    `netsh advfirewall firewall add rule name="Agent Hub (Tailscale)" dir=in action=allow program="${exe}" enable=yes profile=any remoteip=100.64.0.0/10`,
    '',
  ].join('\r\n'));
  await powershell(`Start-Process -FilePath '${script.replace(/'/g, "''")}' -Verb RunAs -WindowStyle Hidden -Wait`);
  return firewallState();
}
/** Windows networks set to "Public" refuse incoming connections whatever the app does. */
async function publicNetworks() {
  if (!WINDOWS) return [];
  const { out } = await powershell("ConvertTo-Json -Compress -InputObject @(Get-NetConnectionProfile | ForEach-Object { [pscustomobject]@{ Name = $_.Name; Category = [string]$_.NetworkCategory; Alias = $_.InterfaceAlias } })");
  try {
    let list = JSON.parse(out.trim() || '[]');
    if (!Array.isArray(list)) list = [list];
    return list.filter((n) => /Public/i.test(n.Category) && !/Tailscale/i.test(n.Alias));
  } catch { return []; }
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
/** Addresses agents can use, for the dashboard (HUB_EXTRA_URLS) and the tray. */
function extraUrls(settings, port) {
  const urls = [];
  if (settings.network && tailscale?.dnsName) urls.push(`Tailscale (your devices, anywhere)=http://${tailscale.dnsName}:${port}`);
  if (settings.funnel && tailscale?.dnsName) urls.push(`Public link (Tailscale Funnel)=https://${tailscale.dnsName}`);
  return urls.join(',');
}
async function startHub() {
  const settings = readSettings();
  // a hub already running here (from the command line, say): use it rather than start a second one
  if (await isHub(settings.port)) {
    attached = true;
    hubPort = settings.port;
    hubUrl = `http://127.0.0.1:${settings.port}`;
    return;
  }
  let port = settings.port;
  while (!(await portFree(port)) && port < settings.port + 20) port++;
  fs.mkdirSync(path.dirname(logFile()), { recursive: true });
  const log = fs.createWriteStream(logFile(), { flags: 'a' });
  log.write(`\n[${new Date().toISOString()}] starting the hub on port ${port}${settings.network ? ' (shared on the network)' : ' (this computer only)'}\n`);
  const args = ['--port', String(port), '--data', dataDir(), '--history', historyDir()];
  if (settings.network) args.push('--host', '0.0.0.0');
  // Electron's own Node runs the hub: no console window, no separate Node.js install
  hub = fork(path.join(HUB_DIR, 'server.mjs'), args, {
    execPath: process.execPath,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HUB_EXTRA_URLS: extraUrls(settings, port) },
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
  hubPort = port;
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
async function restartHub() {
  await stopHub();
  await startHub();
  win?.reload();
  buildTray();
}

// ---------- network check: what stops other devices from connecting, and the fixes ----------
async function checkNetwork({ quiet = false } = {}) {
  const settings = readSettings();
  const lan = lanAddress();
  const problems = [];
  if (!settings.network) problems.push({ text: 'The hub only listens on this computer.', fix: 'Share on the network', action: async () => { writeSettings({ ...readSettings(), network: true }); await restartHub(); } });
  if (WINDOWS && settings.network) {
    const fw = await firewallState();
    if (fw.unknown) fw.ok = true;
    if (!fw.ok && !(quiet && settings.firewallDeclined)) {
      problems.push({
        text: fw.blocked ? 'Windows Firewall blocks Agent Hub (someone chose "Cancel" or "Block" at the Windows prompt).' : 'Windows Firewall does not let other devices reach Agent Hub yet.',
        fix: 'Allow through Windows Firewall',
        action: async () => {
          const after = await fixFirewall();
          writeSettings({ ...readSettings(), firewallDeclined: !after.ok });
          if (!after.ok) dialog.showMessageBox({ type: 'warning', title: 'Firewall unchanged', message: 'Windows Firewall was not changed (the administrator prompt was declined or failed). Other devices still cannot connect.' });
        },
      });
    }
    const pub = fw.coversPublic && !fw.blocked ? [] : await publicNetworks();
    if (pub.length) {
      problems.push({
        text: `Windows treats ${pub.map((n) => `"${n.Name}"`).join(', ')} as a Public network, which refuses incoming connections. If it is your home or office network, set it to Private.`,
        fix: 'Open network settings',
        action: () => shell.openExternal('ms-settings:network-status'),
      });
    }
  }
  if (quiet && !problems.length) return;
  if (quiet && problems.every((p) => p.text.startsWith('The hub only listens'))) return;
  const reach = [lan && settings.network ? `On your network: http://${lan}:${hubPort}` : null, tailscale && settings.network ? `Your devices over Tailscale: http://${tailscale.dnsName || tailscale.ip}:${hubPort}` : null, settings.funnel && tailscale?.dnsName ? `Anywhere on the internet: https://${tailscale.dnsName}` : null].filter(Boolean);
  if (!problems.length) {
    await dialog.showMessageBox({ type: 'info', title: 'Network access', message: 'Other devices can reach this hub.', detail: reach.join('\n') || 'Agents use the addresses listed on the Access panel.' });
    return;
  }
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    title: 'Other devices cannot reach the hub yet',
    message: problems.map((p, i) => `${i + 1}. ${p.text}`).join('\n\n'),
    detail: reach.length ? `Once fixed, agents can use:\n${reach.join('\n')}` : '',
    buttons: [...problems.map((p) => p.fix), 'Not now'],
    cancelId: problems.length,
    noLink: true,
  });
  if (response < problems.length) {
    await problems[response].action();
    setTimeout(() => checkNetwork({ quiet: true }), 1500);
  } else if (quiet) {
    writeSettings({ ...readSettings(), firewallDeclined: true });
  }
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
function bestAddress() {
  const settings = readSettings();
  if (settings.funnel && tailscale?.dnsName) return `https://${tailscale.dnsName}`;
  const lan = lanAddress();
  if (settings.network && lan) return `http://${lan}:${hubPort}`;
  return hubUrl;
}
function buildTray() {
  const settings = readSettings();
  const login = app.getLoginItemSettings();
  const lan = lanAddress();
  const menu = Menu.buildFromTemplate([
    { label: 'Open Agent Hub', click: showWindow },
    { label: 'Open in browser', click: () => shell.openExternal(hubUrl + '/') },
    { label: `Copy the hub's address (${bestAddress().replace(/^https?:\/\//, '')})`, click: () => clipboard.writeText(bestAddress()) },
    { type: 'separator' },
    {
      label: 'Share on the network',
      sublabel: settings.network && lan ? `http://${lan}:${hubPort}` : 'only this computer can connect',
      type: 'checkbox',
      checked: !!settings.network,
      enabled: !attached,
      click: async (item) => {
        writeSettings({ ...readSettings(), network: item.checked, ...(item.checked ? {} : { funnel: false }) });
        if (!item.checked && settings.funnel) await setFunnel(false, hubPort);
        await restartHub();
        if (item.checked) checkNetwork();
      },
    },
    {
      label: 'Internet',
      enabled: !attached,
      submenu: [
        tailscale
          ? { label: settings.network ? `Your devices over Tailscale: ${tailscale.dnsName || tailscale.ip}:${hubPort}` : 'Tailscale: turn on "Share on the network" first', enabled: false }
          : { label: 'Install Tailscale to reach the hub from anywhere…', click: () => shell.openExternal('https://tailscale.com/download') },
        {
          label: 'Public link for agents anywhere (Tailscale Funnel)',
          type: 'checkbox',
          checked: !!settings.funnel,
          enabled: !!tailscale?.dnsName && !!settings.network,
          click: async (item) => {
            if (item.checked) {
              const setup = await fetch(`${hubUrl}/api/setup`).then((r) => r.json()).catch(() => ({}));
              if (!setup.hasAccount) {
                dialog.showMessageBox({ type: 'warning', title: 'Create your account first', message: 'Create your account in Agent Hub before opening it to the internet.' });
                return buildTray();
              }
              const { response } = await dialog.showMessageBox({ type: 'question', title: 'Open the hub to the internet?', message: `Anyone with the link https://${tailscale.dnsName} will reach the sign-in page. Agents still need their tokens, and you your password.`, detail: 'The link uses HTTPS. You can turn it off here at any time.', buttons: ['Open to the internet', 'Cancel'], cancelId: 1, noLink: true });
              if (response !== 0) return buildTray();
            }
            const r = await setFunnel(item.checked, hubPort);
            if (item.checked && !r.ok) {
              const link = r.out.match(/https:\/\/login\.tailscale\.com\/\S+/)?.[0];
              const { response } = await dialog.showMessageBox({ type: 'warning', title: 'Tailscale Funnel is not ready', message: 'Tailscale could not open the public link yet. Funnel and HTTPS certificates must be allowed for your tailnet (one click in the Tailscale admin console).', detail: r.out.slice(0, 600), buttons: link ? ['Open the Tailscale page', 'Close'] : ['Close'], noLink: true });
              if (link && response === 0) shell.openExternal(link);
              return buildTray();
            }
            writeSettings({ ...readSettings(), funnel: item.checked });
            await restartHub();
            if (item.checked) dialog.showMessageBox({ type: 'info', title: 'Public link ready', message: `Agents anywhere can reach the hub at\nhttps://${tailscale.dnsName}`, detail: 'Use this address in the prompts for agents outside your network (Add agent → Hub address).' });
          },
        },
      ],
    },
    { label: 'Check network access…', click: () => checkNetwork() },
    { type: 'separator' },
    { label: 'Open chat history folder', click: () => { fs.mkdirSync(historyDir(), { recursive: true }); shell.openPath(historyDir()); } },
    { label: 'Open data folder', click: () => shell.openPath(attached ? app.getPath('userData') : dataDir()) },
    {
      label: 'Start when I sign in',
      type: 'checkbox',
      checked: login.openAtLogin,
      click: (item) => { app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] }); buildTray(); },
    },
    { type: 'separator' },
    { label: attached ? 'Connected to a hub already running here' : `Running on port ${hubPort}${settings.network ? ', shared on the network' : ', this computer only'}`, enabled: false },
    { label: 'Quit Agent Hub', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(`Agent Hub · ${bestAddress()}`);
}

// ---------- start ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.setAppUserModelId('io.github.protik1810.agenthub');
  app.whenReady().then(async () => {
    tailscale = await findTailscale();
    try {
      await startHub();
    } catch (e) {
      dialog.showErrorBox('Agent Hub could not start', e.message);
      app.exit(1);
      return;
    }
    // keep a public link the owner turned on earlier
    const settings = readSettings();
    if (settings.funnel && settings.network && tailscale && !attached) await setFunnel(true, hubPort);
    tray = new Tray(nativeImage.createFromPath(TRAY_ICON));
    tray.on('click', showWindow);
    tray.on('double-click', showWindow);
    buildTray();
    createWindow({ show: !process.argv.includes('--hidden') });
    // tell the owner, once, if something stops other devices from connecting
    if (!attached && !process.env.AGENT_HUB_NO_NETWORK_CHECK) setTimeout(() => checkNetwork({ quiet: true }).catch(() => {}), 2500);
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
