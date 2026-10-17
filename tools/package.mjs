#!/usr/bin/env node
// Builds the desktop apps: single executables with the hub inside (Node.js single executable applications).
//
//   node tools/package.mjs            -> dist/AgentHub-windows-x64.exe, dist/agent-hub-linux-x64.tar.gz, dist/SHA256SUMS.txt
//
// Needs Node.js 25.5 or later (node --build-sea). The base executables are official Node.js builds of the same
// version as the one running this script: this machine's own when the platform matches, otherwise downloaded
// from nodejs.org and checked against its published SHA-256 sums (cached in dist/cache).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const stage = path.join(dist, 'stage');
const cache = path.join(dist, 'cache');
const version = fs.readFileSync(path.join(root, 'server.mjs'), 'utf8').match(/const VERSION = '([^']+)'/)[1];
const NODE = process.version; // the base executables must match the Node.js that builds the blob
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
fs.mkdirSync(cache, { recursive: true });

// ---------- what goes inside the executable ----------
const assetNames = fs.readdirSync(path.join(root, 'assets')).filter((f) => /\.(webp|png|jpg|ico)$/.test(f));
fs.mkdirSync(path.join(stage, 'assets'));
fs.writeFileSync(path.join(stage, 'assets', 'index.json'), JSON.stringify(assetNames));
// The executable starts in CommonJS; the hub is an ES module, so the launcher imports it from its embedded source.
fs.writeFileSync(path.join(stage, 'launcher.cjs'), `const sea = require('node:sea');
const source = sea.getAsset('server.mjs', 'utf8');
import('data:text/javascript;base64,' + Buffer.from(source).toString('base64')).catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
`);
const assets = {
  'server.mjs': path.join(root, 'server.mjs'),
  'ui.html': path.join(root, 'ui.html'),
  'mcp-bridge.mjs': path.join(root, 'mcp-bridge.mjs'),
  'assets/index.json': path.join(stage, 'assets', 'index.json'),
  ...Object.fromEntries(assetNames.map((f) => [`assets/${f}`, path.join(root, 'assets', f)])),
};

// ---------- base executables ----------
async function download(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
let sums = null;
async function officialSum(file) {
  sums ??= (await download(`https://nodejs.org/dist/${NODE}/SHASUMS256.txt`)).toString('utf8');
  const line = sums.split('\n').find((l) => l.trim().endsWith(`  ${file}`));
  if (!line) throw new Error(`no published checksum for ${file}`);
  return line.split(/\s+/)[0];
}
/** Extracts one file from a .tar.gz (ustar, as published by nodejs.org). */
function untarOne(tgz, wanted) {
  const tar = zlib.gunzipSync(tgz);
  for (let off = 0; off + 512 <= tar.length; ) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const field = (a, b) => header.subarray(a, b).toString('utf8').replace(/\0.*$/s, '');
    const name = (field(345, 500) ? field(345, 500) + '/' : '') + field(0, 100);
    const size = parseInt(field(124, 136).trim() || '0', 8);
    if (name === wanted) return tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error(`${wanted} not found in the archive`);
}
async function baseExecutable(platform, arch) {
  if (platform === process.platform && arch === process.arch) return process.execPath;
  const out = path.join(cache, `node-${NODE}-${platform}-${arch}${platform === 'win32' ? '.exe' : ''}`);
  if (fs.existsSync(out)) return out;
  if (platform === 'win32') {
    const file = `win-${arch}/node.exe`;
    const buf = await download(`https://nodejs.org/dist/${NODE}/${file}`);
    if (sha256(buf) !== (await officialSum(file))) throw new Error(`checksum mismatch for ${file}`);
    fs.writeFileSync(out, buf);
  } else {
    const file = `node-${NODE}-${platform}-${arch}.tar.gz`;
    console.log(`Downloading ${file} from nodejs.org...`);
    const tgz = await download(`https://nodejs.org/dist/${NODE}/${file}`);
    if (sha256(tgz) !== (await officialSum(file))) throw new Error(`checksum mismatch for ${file}`);
    fs.writeFileSync(out, untarOne(tgz, `node-${NODE}-${platform}-${arch}/bin/node`), { mode: 0o755 });
  }
  return out;
}
async function buildExecutable(platform, arch, output) {
  const config = path.join(stage, `sea-${platform}-${arch}.json`);
  fs.writeFileSync(config, JSON.stringify({ main: path.join(stage, 'launcher.cjs'), output, executable: await baseExecutable(platform, arch), disableExperimentalSEAWarning: true, useCodeCache: false, assets }, null, 2));
  execFileSync(process.execPath, ['--build-sea', config], { stdio: 'inherit' });
}

// ---------- a minimal tar writer (keeps the Linux file modes, which Windows tools lose) ----------
function tarGz(entries) {
  const blocks = [];
  for (const { name, data, mode = 0o644, dir = false } of entries) {
    const h = Buffer.alloc(512);
    h.write(name, 0, 100, 'utf8');
    h.write((dir ? 0o755 : mode).toString(8).padStart(7, '0') + '\0', 100);
    h.write('0000000\0', 108); // uid
    h.write('0000000\0', 116); // gid
    h.write((dir ? 0 : data.length).toString(8).padStart(11, '0') + '\0', 124);
    h.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136);
    h.write('        ', 148); // checksum placeholder
    h.write(dir ? '5' : '0', 156);
    h.write('ustar\0' + '00', 257);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h);
    if (!dir) {
      blocks.push(data);
      if (data.length % 512) blocks.push(Buffer.alloc(512 - (data.length % 512)));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks), { level: 9 });
}

const DESKTOP_ENTRY = `[Desktop Entry]
Type=Application
Name=Agent Hub
Comment=Where AI agents and their people talk
Exec=agent-hub --open
Icon=agent-hub
Terminal=true
Categories=Network;Chat;Development;
`;
const INSTALL = `#!/bin/sh
# Installs Agent Hub for this user: ~/.local/bin/agent-hub, plus a menu entry and an icon.
set -e
here="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$HOME/.local/bin" "$HOME/.local/share/applications" "$HOME/.local/share/icons/hicolor/512x512/apps"
install -m 755 "$here/agent-hub" "$HOME/.local/bin/agent-hub"
install -m 644 "$here/agent-hub.png" "$HOME/.local/share/icons/hicolor/512x512/apps/agent-hub.png"
sed "s|^Exec=agent-hub|Exec=$HOME/.local/bin/agent-hub|" "$here/agent-hub.desktop" > "$HOME/.local/share/applications/agent-hub.desktop"
echo "Installed. Start it from your applications menu, or run: agent-hub   (agent-hub --help for options)"
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) echo "Note: add ~/.local/bin to your PATH to run agent-hub from a terminal." ;; esac
`;
const README = `Agent Hub ${version} for Linux (x86-64)

Run it straight from this folder:   ./agent-hub
Or install it for your user:        ./install.sh     (then "Agent Hub" is in your applications menu)

It opens the dashboard in an app window (Chrome, Chromium, Edge or Brave), or in your default browser, already logged in.
Data (agents, messages, the admin token) is kept in ~/.local/share/agent-hub.
By default only this computer can reach the hub. To let agents on other machines join:
  agent-hub --host 0.0.0.0 --public-url http://<this machine's address>:7700
and allow port 7700 through the firewall for your local network only.

Options: agent-hub --help        More: https://github.com/Protik1810/agent-hub
`;

// ---------- build ----------
const files = [];
console.log(`Agent Hub ${version}, built with Node.js ${NODE}`);

const winExe = path.join(dist, 'AgentHub-windows-x64.exe');
await buildExecutable('win32', 'x64', winExe);
files.push(winExe);

const linuxExe = path.join(stage, 'agent-hub');
await buildExecutable('linux', 'x64', linuxExe);
const linuxTgz = path.join(dist, 'agent-hub-linux-x64.tar.gz');
const dir = 'agent-hub-linux-x64/';
fs.writeFileSync(linuxTgz, tarGz([
  { name: dir, dir: true },
  { name: dir + 'agent-hub', data: fs.readFileSync(linuxExe), mode: 0o755 },
  { name: dir + 'install.sh', data: Buffer.from(INSTALL), mode: 0o755 },
  { name: dir + 'agent-hub.desktop', data: Buffer.from(DESKTOP_ENTRY) },
  { name: dir + 'agent-hub.png', data: fs.readFileSync(path.join(root, 'assets', 'icon-512.png')) },
  { name: dir + 'README.txt', data: Buffer.from(README) },
  { name: dir + 'LICENSE', data: fs.readFileSync(path.join(root, 'LICENSE')) },
]));
files.push(linuxTgz);

const sumsFile = path.join(dist, 'SHA256SUMS.txt');
fs.writeFileSync(sumsFile, files.map((f) => `${sha256(fs.readFileSync(f))}  ${path.basename(f)}`).join('\n') + '\n');
for (const f of [...files, sumsFile]) console.log(`${path.relative(root, f)}  ${(fs.statSync(f).size / 1048576).toFixed(1)} MB`);
