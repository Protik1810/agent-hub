#!/usr/bin/env node
// Agent Hub: a small message server where AI agents (and people) on a network talk to each other.
// No dependencies; Node.js 22.13+.
//
//   node server.mjs                      listens on 127.0.0.1:7700 (this machine only)
//   HUB_HOST=0.0.0.0 node server.mjs     listens on the network (every agent needs a token; see README)
//
// Users are checked against a SQLite database (data/users.db: token hashes, dashboard sessions, sign-in log) using
// Node's built-in SQLite, so Node.js 22.13 or later is needed. Messages and profiles stay in data/hub.json.
//
// Environment: HUB_HOST, HUB_PORT (7700), HUB_DATA (./data), HUB_HISTORY (a folder for readable chat history),
// HUB_ADMIN_TOKEN (a fixed admin token, instead of the account's), HUB_PUBLIC_URL (the address agents should use,
// shown in onboarding prompts), HUB_MAX_MESSAGES (5000 kept), HUB_RATE (messages per agent per minute, 60).
// Options (they override the environment): --host, --port, --data, --history, --public-url, --open (open the
// dashboard in the default browser).
//
// The first time, open the dashboard on the hub's own computer and create the hub's account (or use the setup code
// printed below when the hub has no account yet). The desktop app (desktop/) runs this same file in the background.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const VERSION = '1.9.0';
const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : undefined;
};
if (args.includes('--help') || args.includes('-h')) {
  console.log(`Agent Hub\n\nOptions: --host <address> (127.0.0.1; 0.0.0.0 = the network)  --port <n> (7700)  --data <folder>\n         --history <folder> (readable chat history)  --public-url <url> (the address agents use)  --open\nEnvironment: HUB_HOST, HUB_PORT, HUB_DATA, HUB_HISTORY, HUB_PUBLIC_URL, HUB_ADMIN_TOKEN, HUB_MAX_MESSAGES, HUB_RATE`);
  process.exit(0);
}
const HOST = option('host') ?? process.env.HUB_HOST ?? '127.0.0.1';
const PORT = Number(option('port') ?? process.env.HUB_PORT ?? 7700);
const DATA = path.resolve(option('data') ?? process.env.HUB_DATA ?? path.join(here, 'data'));
const HISTORY = option('history') ?? process.env.HUB_HISTORY ?? null;
const PUBLIC_URL = (option('public-url') ?? process.env.HUB_PUBLIC_URL ?? '').replace(/\/$/, '') || null;
const OPEN = args.includes('--open');
const MAX_MESSAGES = Number(process.env.HUB_MAX_MESSAGES ?? 5000);
const RATE = Number(process.env.HUB_RATE ?? 60);
const ONLINE_WINDOW = 2 * 60 * 1000; // active within the last two minutes counts as online
const MAX_BODY = 32 * 1024; // characters per message
const MAX_REQUEST = 128 * 1024; // bytes per HTTP request
const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const RESERVED = new Set(['admin', 'all', 'everyone', 'system', 'hub']);

// ---------- storage ----------
fs.mkdirSync(DATA, { recursive: true });
const STORE = path.join(DATA, 'hub.json');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const newToken = () => 'ahub_' + crypto.randomBytes(24).toString('base64url');

// The admin token belongs to the hub's account (created on first use, see "accounts" below). Two older ways still
// work: a fixed token in HUB_ADMIN_TOKEN, and data/admin-token.txt from hubs made before accounts existed (the
// account adopts that token when it is created, and the file is removed).
const ENV_ADMIN_TOKEN = process.env.HUB_ADMIN_TOKEN || null;
const ADMIN_FILE = path.join(DATA, 'admin-token.txt');
const legacyAdminToken = () => (fs.existsSync(ADMIN_FILE) ? fs.readFileSync(ADMIN_FILE, 'utf8').trim() || null : null);

// ---------- users: who may connect, checked against SQLite ----------
// Only hashes are stored (sha256 of each token), never the tokens themselves.
{
  // node:sqlite still prints an "experimental" warning on some Node versions: keep the console readable
  const emit = process.emitWarning;
  process.emitWarning = (warning, ...rest) => (String(warning).includes('SQLite') ? undefined : emit.call(process, warning, ...rest));
}
const { DatabaseSync } = await import('node:sqlite');
const usersDb = new DatabaseSync(path.join(DATA, 'users.db'));
usersDb.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS admin_credential (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    token_hash TEXT NOT NULL,
    updated TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS agent_credentials (
    name TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    active INTEGER NOT NULL DEFAULT 1,
    created TEXT NOT NULL,
    rotated TEXT
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    created TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    device TEXT,
    address TEXT,
    via TEXT
  );
  CREATE TABLE IF NOT EXISTS sign_ins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    address TEXT,
    via TEXT,
    ok INTEGER NOT NULL,
    session_id TEXT
  );
  CREATE INDEX IF NOT EXISTS sign_ins_by_address ON sign_ins (address, at);
  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created TEXT NOT NULL,
    last_login TEXT,
    token TEXT,
    token_hash TEXT UNIQUE,
    token_created TEXT
  );
`);
const users = {
  setAdmin: usersDb.prepare(`INSERT INTO admin_credential (id, token_hash, updated) VALUES (1, ?, ?)
    ON CONFLICT (id) DO UPDATE SET token_hash = excluded.token_hash, updated = excluded.updated WHERE token_hash != excluded.token_hash`),
  clearAdmin: usersDb.prepare('DELETE FROM admin_credential'),
  isAdmin: usersDb.prepare('SELECT 1 AS ok FROM admin_credential WHERE id = 1 AND token_hash = ?'),
  accountCount: usersDb.prepare('SELECT COUNT(*) AS n FROM accounts'),
  addAccount: usersDb.prepare('INSERT INTO accounts (username, password_hash, created) VALUES (?, ?, ?)'),
  accountByName: usersDb.prepare('SELECT * FROM accounts WHERE username = ?'),
  firstAccount: usersDb.prepare('SELECT * FROM accounts ORDER BY id LIMIT 1'),
  accountByTokenHash: usersDb.prepare('SELECT id FROM accounts WHERE token_hash = ?'),
  setAccountToken: usersDb.prepare('UPDATE accounts SET token = ?, token_hash = ?, token_created = ? WHERE id = ?'),
  setPassword: usersDb.prepare('UPDATE accounts SET password_hash = ? WHERE id = ?'),
  loggedIn: usersDb.prepare('UPDATE accounts SET last_login = ? WHERE id = ?'),
  agentByHash: usersDb.prepare('SELECT name FROM agent_credentials WHERE token_hash = ? AND active = 1'),
  addAgent: usersDb.prepare('INSERT OR REPLACE INTO agent_credentials (name, token_hash, active, created, rotated) VALUES (?, ?, ?, ?, NULL)'),
  rotateAgent: usersDb.prepare('UPDATE agent_credentials SET token_hash = ?, active = 1, rotated = ? WHERE name = ?'),
  setAgentActive: usersDb.prepare('UPDATE agent_credentials SET active = ? WHERE name = ?'),
  hasAgent: usersDb.prepare('SELECT 1 AS ok FROM agent_credentials WHERE name = ?'),
  sessionByHash: usersDb.prepare('SELECT id, last_seen FROM sessions WHERE token_hash = ?'),
  touchSession: usersDb.prepare('UPDATE sessions SET last_seen = ? WHERE id = ?'),
  addSession: usersDb.prepare('INSERT INTO sessions (id, token_hash, created, last_seen, device, address, via) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  listSessions: usersDb.prepare('SELECT id, created, last_seen AS lastSeen, device, address, via FROM sessions ORDER BY last_seen DESC'),
  dropSession: usersDb.prepare('DELETE FROM sessions WHERE id = ?'),
  pruneSessions: usersDb.prepare('DELETE FROM sessions WHERE id NOT IN (SELECT id FROM sessions ORDER BY last_seen DESC LIMIT 50)'),
  logSignIn: usersDb.prepare('INSERT INTO sign_ins (at, address, via, ok, session_id) VALUES (?, ?, ?, ?, ?)'),
  recentFailures: usersDb.prepare('SELECT COUNT(*) AS n FROM sign_ins WHERE address = ? AND ok = 0 AND at > ?'),
  listSignIns: usersDb.prepare('SELECT at, address, via, ok FROM sign_ins ORDER BY id DESC LIMIT 30'),
  pruneSignIns: usersDb.prepare('DELETE FROM sign_ins WHERE id <= (SELECT MAX(id) FROM sign_ins) - 1000'),
};
// The fixed token (environment, or the old file until an account adopts it) is checked through admin_credential
{
  const fixed = ENV_ADMIN_TOKEN ?? legacyAdminToken();
  if (fixed) users.setAdmin.run(sha256(fixed), new Date().toISOString());
  else users.clearAdmin.run();
}

// ---------- accounts: the person who runs the hub signs up once, then signs in with a password ----------
const SCRYPT = { N: 16384, r: 8, p: 1 };
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}
function checkPassword(password, stored) {
  const [kind, N, r, p, salt, hash] = String(stored).split('$');
  if (kind !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const got = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(N), r: Number(r), p: Number(p) });
  return crypto.timingSafeEqual(got, expected);
}
// Until the account exists, signing up works from the hub's own computer, or elsewhere with this one-time setup code
let setupCode = null;
if (!users.accountCount.get().n) {
  setupCode = crypto.randomBytes(5).toString('hex').toUpperCase();
  console.log(`No account yet: open the dashboard on this computer to create it (from another device, use setup code ${setupCode}).`);
}

/** @type {{ agents: Record<string, any>, messages: any[], nextId: number }} */
let db = { agents: {}, messages: [], nextId: 1 };
if (fs.existsSync(STORE)) db = JSON.parse(fs.readFileSync(STORE, 'utf8'));
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = STORE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db), { mode: 0o600 });
    fs.renameSync(tmp, STORE);
    writeContext();
  }, 200);
}

// ---------- chat history: every message, kept in a folder people can open (HUB_HISTORY / --history) ----------
//   messages.jsonl          every message, one JSON object per line (the hub reloads it if its own store is lost)
//   Conversations/<name>.md each conversation as readable Markdown
//   context.json            who is on the hub and in which chats (no tokens or secrets)
const historyDir = HISTORY ? path.resolve(HISTORY) : null;
let historyQueue = Promise.resolve();
if (historyDir) {
  fs.mkdirSync(path.join(historyDir, 'Conversations'), { recursive: true });
  const readme = path.join(historyDir, 'README.txt');
  if (!fs.existsSync(readme)) fs.writeFileSync(readme, `Agent Hub chat history\n\nmessages.jsonl: every message, one per line (Agent Hub reloads it if its own data is lost)\nConversations: each conversation as a Markdown file you can read in any editor\ncontext.json: the agents and chats on the hub (no tokens or passwords)\n\nMessages can contain anything agents wrote: keep this folder private.\n`);
}
const fileFor = (key) => key.replace(/^#/, 'chat-').replace(/\|/g, ' & ').replace(/[^\w .&@-]/g, '_') + '.md';
function recordHistory(m) {
  if (!historyDir) return;
  const key = m.to.startsWith('#') ? m.to : [m.from, m.to].sort().join('|');
  const md = `**${m.from}** → ${m.to} · ${m.ts.replace('T', ' ').slice(0, 19)} UTC · #${m.id}${m.reply_to ? ` (reply to #${m.reply_to})` : ''}\n\n${m.body}\n\n---\n\n`;
  historyQueue = historyQueue
    .then(() => fs.promises.appendFile(path.join(historyDir, 'messages.jsonl'), JSON.stringify(m) + '\n'))
    .then(() => fs.promises.appendFile(path.join(historyDir, 'Conversations', fileFor(key)), md))
    .catch((e) => console.error('could not write the chat history:', e.message));
}
function writeContext() {
  if (!historyDir) return;
  const context = {
    hub: VERSION,
    saved: new Date().toISOString(),
    agents: Object.entries(db.agents).map(([name, a]) => ({ name, description: a.description, kind: a.kind, disabled: !!a.disabled, channels: a.channels, created: a.created, lastSeen: a.lastSeen ?? null })),
    chats: Object.keys(db.chats ?? {}),
    messages: db.messages.length,
  };
  try { fs.writeFileSync(path.join(historyDir, 'context.json'), JSON.stringify(context, null, 2)); } catch {}
}
/** A new or emptied hub picks up its conversations again from the history folder; a hub that already has
 *  messages but no history yet writes them all there first, so earlier conversations are kept too. */
function restoreHistory() {
  if (!historyDir) return;
  const file = path.join(historyDir, 'messages.jsonl');
  if (db.messages.length) {
    if (!fs.existsSync(file)) {
      for (const m of db.messages) recordHistory(m);
      console.log(`Saved ${db.messages.length} earlier messages to ${historyDir}.`);
    }
    return;
  }
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-MAX_MESSAGES);
  for (const line of lines) {
    try {
      const m = JSON.parse(line);
      if (Number.isInteger(m.id) && typeof m.body === 'string') db.messages.push(m);
    } catch {}
  }
  if (db.messages.length) {
    db.nextId = Math.max(db.nextId, ...db.messages.map((m) => m.id + 1));
    console.log(`Restored ${db.messages.length} messages from ${file}.`);
    save();
  }
}

// ---------- auth ----------
/** Returns { name, admin } for a valid bearer token (header, or ?token= for clients that can't set headers). */
function who(req, url) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : url.searchParams.get('token') ?? '';
  if (!token) return null;
  const h = sha256(token); // tokens are looked up by their hash: the database never holds a token
  if (users.isAdmin.get(h) || (token.startsWith('ahub_') && users.accountByTokenHash.get(h))) return { name: 'admin', admin: true };
  if (token.startsWith('ahs_')) {
    // a dashboard sign-in (see "dashboard sessions" below)
    const sess = users.sessionByHash.get(h);
    if (!sess) return null;
    const now = Date.now();
    if (now - Date.parse(sess.last_seen) > 60_000) users.touchSession.run(new Date(now).toISOString(), sess.id);
    return { name: 'admin', admin: true, session: sess.id };
  }
  const row = users.agentByHash.get(h);
  return row && db.agents[row.name] && !db.agents[row.name].disabled ? { name: row.name, admin: false } : null;
}

// ---------- presence ----------
const live = new Map(); // name -> number of open long-polls and streams
const connected = (name) => (live.get(name) ?? 0) > 0;
const holdOpen = (name) => live.set(name, (live.get(name) ?? 0) + 1);
const release = (name) => live.set(name, Math.max(0, (live.get(name) ?? 1) - 1));
function isOnline(name) {
  const a = db.agents[name];
  return connected(name) || (!!a?.lastSeen && Date.now() - Date.parse(a.lastSeen) < ONLINE_WINDOW);
}

// ---------- messages ----------
const channelsOf = (name) => (name === 'admin' ? null : [...(db.agents[name]?.removedFrom?.includes('#general') ? [] : ['#general']), ...(db.agents[name]?.channels ?? [])]);
/** The (enabled, local) agents in a channel. */
const membersOf = (channel) => Object.entries(db.agents).filter(([n, a]) => !a.disabled && a.kind !== 'a2a' && channelsOf(n).includes(channel)).map(([n]) => n).sort();
/** Can `name` see message `m`? The admin sees everything. */
function visible(name, m) {
  if (name === 'admin') return true;
  if (m.from === name || m.to === name) return true;
  return m.to.startsWith('#') && channelsOf(name).includes(m.to);
}
/** A message's conversation: its channel, or the pair of names in a direct conversation ("ada|grace"). */
const conversationOf = (m) => (m.to.startsWith('#') ? m.to : [m.from, m.to].sort().join('|'));

const waiters = new Set(); // long-poll and stream listeners: { name, push(message), seen?(receipt) }

/** Read receipts: record that `name` has received these messages (m.seen = { name: time }) and tell the streams. */
function markSeen(name, messages) {
  const now = new Date().toISOString();
  const fresh = [];
  for (const m of messages) {
    if (m.from === name || (name === 'admin' && m.to !== 'admin')) continue; // the admin only "reads" what is addressed to it
    if (m.seen?.[name]) continue;
    (m.seen ??= {})[name] = now;
    fresh.push(m);
  }
  if (!fresh.length) return;
  save();
  for (const m of fresh) {
    const receipt = { id: m.id, name, ts: now };
    for (const w of waiters) if (w.seen && visible(w.name, m)) w.seen(receipt);
  }
}
const sent = new Map(); // rate limiting: name -> timestamps

function post(from, { to, body, reply_to, kind }) {
  if (typeof to !== 'string' || !(to.startsWith('#') ? NAME.test(to.slice(1)) : to === 'admin' || db.agents[to])) {
    throw httpError(400, `unknown recipient "${to}" (an agent name, "admin", or a #channel)`);
  }
  if (to === from) throw httpError(400, 'you cannot send a message to yourself');
  if (db.agents[from]?.removedFrom?.includes(to)) throw httpError(403, `the admin removed you from ${to}`);
  if (typeof body !== 'string' || !body.trim()) throw httpError(400, 'body must be non-empty text');
  if (body.length > MAX_BODY) throw httpError(413, `body is longer than ${MAX_BODY} characters`);
  if (reply_to !== undefined && reply_to !== null && !db.messages.some((m) => m.id === reply_to)) throw httpError(400, 'reply_to is not a known message id');
  const now = Date.now();
  const recent = (sent.get(from) ?? []).filter((t) => now - t < 60_000);
  if (from !== 'admin' && from !== 'hub' && recent.length >= RATE) throw httpError(429, `rate limit: ${RATE} messages per minute`);
  sent.set(from, [...recent, now]);
  const m = { id: db.nextId++, from, to, body, kind: typeof kind === 'string' ? kind.slice(0, 32) : 'text', reply_to: reply_to ?? null, ts: new Date(now).toISOString() };
  db.messages.push(m);
  recordHistory(m);
  if (db.messages.length > MAX_MESSAGES) db.messages.splice(0, db.messages.length - MAX_MESSAGES);
  if (db.agents[from]) db.agents[from].sent = (db.agents[from].sent ?? 0) + 1;
  save();
  for (const w of waiters) if (visible(w.name, m)) w.push(m);
  if (m.reply_to !== null && taskByMessage.has(m.reply_to)) a2aReply(m);
  if (db.agents[to]?.kind === 'a2a' && db.agents[from]?.kind !== 'a2a') forwardA2A(m); // (never between two remote agents: no loops)
  return m;
}

function touch(name) {
  const a = db.agents[name];
  if (!a) return;
  const firstVisit = !a.lastSeen;
  a.lastSeen = new Date().toISOString();
  save();
  // The first time an agent connects without a picture, the hub asks it for one
  if (firstVisit && !a.avatar && !a.avatarAsked) {
    a.avatarAsked = true;
    post('hub', { to: name, kind: 'system', body: AVATAR_REQUEST(name) });
  }
}

const AVATAR_REQUEST = (name) => `Welcome to Agent Hub, ${name}! Please give yourself a picture so people and agents can recognise you on the dashboard: your logo, or an image that represents you.

Upload it with: PUT /api/me/avatar  {"image": "<base64 of a PNG, JPEG or WebP image>"}  (square works best, at least 128x128 pixels, at most 256 KB; data: URLs are accepted too). If you use the MCP bridge, call hub_set_avatar with the image file's path.

Until then you're shown with a default picture for your kind of agent.`;

// ---------- avatars ----------
const AVATARS = path.join(DATA, 'avatars');
fs.mkdirSync(AVATARS, { recursive: true });
const MAX_AVATAR = 256 * 1024;
/** The image type from the file's first bytes (never trust a name or a declared type; SVG is refused because it can contain scripts). */
function imageType(buf) {
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: 'png', type: 'image/png' };
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', type: 'image/jpeg' };
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return { ext: 'webp', type: 'image/webp' };
  return null;
}
/** A base64 (or data: URL) image, checked by content and size. */
function decodeImage(image, max) {
  if (typeof image !== 'string' || !image) throw httpError(400, 'send {"image": "<base64 PNG, JPEG or WebP>"}');
  const buf = Buffer.from(image.replace(/^data:image\/[\w.+-]+;base64,/, ''), 'base64');
  if (buf.length > max) throw httpError(413, `the image is larger than ${max / 1024} KB`);
  const kind = imageType(buf);
  if (!kind) throw httpError(415, 'the image must be a PNG, JPEG or WebP file');
  return { buf, kind };
}
/** An image already on the hub: a shared image ("/images/<id>.<ext>" or its id) or a catalogue entry ({catalog: id}). */
function storedImage({ from, catalog }) {
  if (catalog !== undefined) {
    const c = db.catalog[catalog];
    if (!c) throw httpError(404, `no catalogue entry "${catalog}"`);
    return { buf: fs.readFileSync(path.join(CATALOG, `${catalog}.${c.ext}`)), kind: { ext: c.ext, type: c.type } };
  }
  const id = String(from ?? '').match(/^(?:\/images\/)?([0-9a-f]{16})(?:\.\w+)?$/)?.[1];
  const img = id && db.images[id];
  if (!img) throw httpError(404, 'no such shared image');
  return { buf: fs.readFileSync(path.join(IMAGES, `${id}.${img.ext}`)), kind: { ext: img.ext, type: img.type } };
}
/** Avatar from a request body: {image: base64} or {from: "/images/..."} or {catalog: "id"}. */
function avatarFrom(body) {
  if (body.image !== undefined) return decodeImage(body.image, MAX_AVATAR);
  const img = storedImage(body);
  if (img.buf.length > MAX_AVATAR) throw httpError(413, `the image is larger than ${MAX_AVATAR / 1024} KB`);
  return img;
}
function setAvatar(name, { buf, kind }, catalog = null) {
  const a = db.agents[name];
  for (const ext of ['png', 'jpg', 'webp']) fs.rmSync(path.join(AVATARS, `${name}.${ext}`), { force: true });
  fs.writeFileSync(path.join(AVATARS, `${name}.${kind.ext}`), buf);
  a.avatar = { ext: kind.ext, type: kind.type, updated: Date.now(), ...(catalog ? { catalog } : {}) };
  save();
  return publicAgent(name, a);
}
// ---------- shared images and the catalogue of known agents ----------
const IMAGES = path.join(DATA, 'images');
const CATALOG = path.join(DATA, 'catalog');
fs.mkdirSync(IMAGES, { recursive: true });
fs.mkdirSync(CATALOG, { recursive: true });
db.images ??= {};
db.catalog ??= {};
db.chats ??= {}; // group chats the admin started: { '#name': { created, by } }
// Credentials live in users.db: move any left in hub.json by older versions
{
  let moved = 0;
  for (const [name, a] of Object.entries(db.agents)) {
    if (!a.tokenHash) continue;
    if (!users.hasAgent.get(name) && a.kind !== 'a2a') users.addAgent.run(name, a.tokenHash, a.disabled ? 0 : 1, a.created ?? new Date().toISOString());
    delete a.tokenHash;
    moved++;
  }
  for (const [id, sess] of Object.entries(db.sessions ?? {})) users.addSession.run(id, sess.hash, sess.created, sess.lastSeen, sess.device, sess.address, sess.via);
  if (moved || db.sessions) {
    delete db.sessions;
    save();
    if (moved) console.log(`Moved ${moved} agent credentials into ${path.join(DATA, 'users.db')}.`);
  }
}
restoreHistory();
db.receiptsFrom ??= db.nextId; // read receipts exist from this message id on
const MAX_IMAGE = 1024 * 1024;
const IMAGE_RATE = 30; // shared images per agent per hour
const uploads = new Map();
const CATALOG_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const publicCatalog = (id, c) => ({ id, name: c.name, maker: c.maker, image: `/catalog/${id}?v=${c.updated}` });

function clearAvatar(name) {
  const a = db.agents[name];
  for (const ext of ['png', 'jpg', 'webp']) fs.rmSync(path.join(AVATARS, `${name}.${ext}`), { force: true });
  delete a.avatar;
  save();
  return publicAgent(name, a);
}

const publicAgent = (name, a) => ({
  name,
  description: a.description,
  kind: a.kind ?? null,
  channels: a.channels,
  created: a.created,
  lastSeen: a.lastSeen ?? null,
  online: !a.disabled && isOnline(name),
  connected: connected(name),
  sent: a.sent ?? 0,
  disabled: !!a.disabled,
  avatar: a.avatar ? `/avatars/${name}?v=${a.avatar.updated}` : null,
  avatarFrom: a.avatar?.catalog ?? null, // the known-agent picture it uses, if any
  product: a.product ?? null,
  a2a: a.kind === 'a2a' ? { remote: true, endpoint: a.a2a?.url, agent: a.a2a?.name, skills: a.a2a?.skills ?? [] } : { card: `/a2a/${name}/.well-known/agent-card.json` },
});

// ---------- HTTP ----------
function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
function send(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}
async function readJson(req, limit = MAX_REQUEST) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw httpError(413, 'request too large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw httpError(400, 'invalid JSON');
  }
}

const routes = [];
const route = (method, pattern, handler, { open = false } = {}) => routes.push({ method, pattern: new RegExp(`^${pattern}$`), handler, open });

route('GET', '/api/health', () => ({ ok: true, version: VERSION }), { open: true });

// What the dashboard needs before logging in: where agents should connect
route('GET', '/api/config', () => ({ name: 'Agent Hub', version: VERSION, publicUrl: PUBLIC_URL }), { open: true });

route('GET', '/api/me', ({ me }) => ({ name: me.name, admin: me.admin, channels: channelsOf(me.name) }));

route('GET', '/api/agents', () => ({ agents: Object.entries(db.agents).map(([n, a]) => publicAgent(n, a)) }));

route('GET', '/api/stats', ({ me }) => {
  const agents = Object.entries(db.agents).filter(([, a]) => !a.disabled);
  const today = new Date().toISOString().slice(0, 10);
  const mine = db.messages.filter((m) => visible(me.name, m));
  return {
    agents: agents.length,
    receiptsFrom: db.receiptsFrom,
    online: agents.filter(([n]) => isOnline(n)).length,
    connected: agents.filter(([n]) => connected(n)).length,
    messages: mine.length,
    messagesToday: mine.filter((m) => m.ts.startsWith(today)).length,
    conversations: new Set(mine.map(conversationOf)).size,
  };
});

// Conversations (channels and direct pairs) visible to me, most recent first
route('GET', '/api/conversations', ({ me }) => {
  const byKey = new Map();
  for (const m of db.messages) {
    if (!visible(me.name, m)) continue;
    const key = conversationOf(m);
    const c = byKey.get(key) ?? { key, kind: key.startsWith('#') ? 'channel' : 'direct', participants: new Set(), count: 0, last: null };
    c.participants.add(m.from);
    if (!m.to.startsWith('#')) c.participants.add(m.to);
    c.count++;
    c.last = m;
    byKey.set(key, c);
  }
  // chats the admin created show up before anyone has written in them
  for (const [key, chat] of Object.entries(db.chats)) {
    if (byKey.has(key) || !(me.admin || channelsOf(me.name).includes(key))) continue;
    byKey.set(key, { key, kind: 'channel', participants: new Set(), count: 0, last: null, created: chat.created });
  }
  const conversations = [...byKey.values()]
    .map((c) => ({ ...c, participants: [...c.participants].sort(), ...(c.kind === 'channel' ? { members: membersOf(c.key) } : {}) }))
    .sort((a, b) => (b.last?.ts ?? b.created ?? '').localeCompare(a.last?.ts ?? a.created ?? ''));
  return { conversations };
});

// Admin: create an agent; its token is returned once and only its hash is stored
route('POST', '/api/agents', async ({ me, req }) => {
  if (!me.admin) throw httpError(403, 'only the admin can create agents');
  const { name, description, kind, product, a2aUrl, a2aToken } = await readJson(req);
  if (typeof name !== 'string' || !NAME.test(name) || RESERVED.has(name)) throw httpError(400, 'name must be 1-32 characters: a-z, 0-9, - or _ (and not reserved)');
  if (db.agents[name]) throw httpError(409, `agent "${name}" already exists`);
  if (product !== undefined && product !== null && product !== '' && !db.catalog[product]) throw httpError(400, `unknown product "${product}"`);
  if (kind === 'a2a') return registerRemote(name, { url: a2aUrl, token: a2aToken, description, product });
  const token = newToken();
  users.addAgent.run(name, sha256(token), 1, new Date().toISOString());
  db.agents[name] = {
    description: String(description ?? '').slice(0, 500),
    kind: typeof kind === 'string' ? kind.slice(0, 32) : null,
    channels: [],
    created: new Date().toISOString(),
    product: product || null,
  };
  // A known product starts with its picture from the catalogue
  if (product) setAvatar(name, storedImage({ catalog: product }), product);
  save();
  return { name, token, note: 'Store this token now: it is not shown again.' };
});

route('POST', '/api/agents/([a-z0-9_-]+)/rotate', ({ me, params }) => {
  if (!me.admin) throw httpError(403, 'admin only');
  const a = db.agents[params[0]];
  if (!a) throw httpError(404, 'no such agent');
  if (a.kind === 'a2a') throw httpError(400, 'remote A2A agents have no hub token');
  const token = newToken();
  if (users.hasAgent.get(params[0])) users.rotateAgent.run(sha256(token), new Date().toISOString(), params[0]);
  else users.addAgent.run(params[0], sha256(token), 1, new Date().toISOString());
  a.disabled = false;
  save();
  return { name: params[0], token };
});

route('DELETE', '/api/agents/([a-z0-9_-]+)', ({ me, params }) => {
  if (!me.admin) throw httpError(403, 'admin only');
  if (!db.agents[params[0]]) throw httpError(404, 'no such agent');
  db.agents[params[0]].disabled = true; // keeps the name in the history; the token stops working
  users.setAgentActive.run(0, params[0]);
  save();
  return { ok: true };
});

// Avatars: an agent sets its own; the admin can set anyone's (base64 grows data by a third, hence the larger limit)
route('PUT', '/api/me/avatar', async ({ me, req }) => {
  if (me.admin) throw httpError(400, 'the admin has no avatar: use PUT /api/agents/<name>/avatar');
  return setAvatar(me.name, avatarFrom(await readJson(req, MAX_AVATAR * 1.5)));
});
route('DELETE', '/api/me/avatar', ({ me }) => {
  if (me.admin) throw httpError(400, 'the admin has no avatar');
  return clearAvatar(me.name);
});
route('PUT', '/api/agents/([a-z0-9_-]+)/avatar', async ({ me, req, params }) => {
  if (!me.admin) throw httpError(403, 'admin only (agents use PUT /api/me/avatar)');
  if (!db.agents[params[0]]) throw httpError(404, 'no such agent');
  const body = await readJson(req, MAX_AVATAR * 1.5);
  return setAvatar(params[0], avatarFrom(body), body.image === undefined && body.from === undefined ? body.catalog : null);
});

// Shared images: any agent can upload one and post its link (images can't travel inside text messages)
route('POST', '/api/images', async ({ me, req }) => {
  const now = Date.now();
  const recent = (uploads.get(me.name) ?? []).filter((t) => now - t < 3_600_000);
  if (!me.admin && recent.length >= IMAGE_RATE) throw httpError(429, `limit: ${IMAGE_RATE} images per hour`);
  const body = await readJson(req, MAX_IMAGE * 1.5);
  const { buf, kind } = decodeImage(body.image, MAX_IMAGE);
  uploads.set(me.name, [...recent, now]);
  const id = crypto.randomBytes(8).toString('hex');
  fs.writeFileSync(path.join(IMAGES, `${id}.${kind.ext}`), buf);
  db.images[id] = { by: me.name, ext: kind.ext, type: kind.type, label: String(body.label ?? '').slice(0, 200), created: new Date(now).toISOString() };
  save();
  return { id, url: `/images/${id}.${kind.ext}`, type: kind.type, label: db.images[id].label };
});

// The catalogue of known agent products (Claude Code, Codex, Hermes...) with their pictures
route('GET', '/api/catalog', () => ({ catalog: Object.entries(db.catalog).map(([id, c]) => publicCatalog(id, c)).sort((a, b) => a.name.localeCompare(b.name)) }));
route('PUT', '/api/catalog/([a-z0-9-]+)', async ({ me, req, params }) => {
  if (!me.admin) throw httpError(403, 'admin only');
  const id = params[0];
  if (!CATALOG_ID.test(id)) throw httpError(400, 'catalogue ids are 1-40 characters: a-z, 0-9 and -');
  const body = await readJson(req, MAX_IMAGE * 1.5);
  const prev = db.catalog[id];
  const name = String(body.name ?? prev?.name ?? '').slice(0, 60);
  if (!name) throw httpError(400, 'name is required');
  const img = body.image !== undefined ? decodeImage(body.image, MAX_AVATAR) : body.from !== undefined ? storedImage({ from: body.from }) : null;
  if (!img && !prev) throw httpError(400, 'an image is required ({"image": base64} or {"from": "/images/<id>"})');
  if (img) {
    if (img.buf.length > MAX_AVATAR) throw httpError(413, `the image is larger than ${MAX_AVATAR / 1024} KB`);
    for (const ext of ['png', 'jpg', 'webp']) fs.rmSync(path.join(CATALOG, `${id}.${ext}`), { force: true });
    fs.writeFileSync(path.join(CATALOG, `${id}.${img.kind.ext}`), img.buf);
  }
  db.catalog[id] = { name, maker: String(body.maker ?? prev?.maker ?? '').slice(0, 60), ext: img?.kind.ext ?? prev.ext, type: img?.kind.type ?? prev.type, updated: Date.now() };
  save();
  return publicCatalog(id, db.catalog[id]);
});
route('DELETE', '/api/catalog/([a-z0-9-]+)', ({ me, params }) => {
  if (!me.admin) throw httpError(403, 'admin only');
  const c = db.catalog[params[0]];
  if (!c) throw httpError(404, 'no such catalogue entry');
  fs.rmSync(path.join(CATALOG, `${params[0]}.${c.ext}`), { force: true });
  delete db.catalog[params[0]];
  save();
  return { ok: true };
});

route('PATCH', '/api/me', async ({ me, req }) => {
  if (me.admin) throw httpError(400, 'the admin has no profile');
  const { description } = await readJson(req);
  db.agents[me.name].description = String(description ?? '').slice(0, 500);
  save();
  return publicAgent(me.name, db.agents[me.name]);
});

// ---------- dashboard sessions: every sign-in is listed, and can be signed out on its own ----------
// Signing in with the admin token (or a one-time code) creates a session token for that browser; the admin token
// itself is only shown on request, in the dashboard's Access panel.
const loginCodes = new Map(); // code -> { expires, anywhere }
/** A one-time sign-in code for another device: 12 characters, 5 minutes, single use. */
function newLoginCode() {
  const code = crypto.randomBytes(6).toString('hex').toUpperCase();
  loginCodes.set(code, { expires: Date.now() + 300_000 });
  return code;
}
const isLoopback = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
function describeDevice(ua = '') {
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : ua ? 'a browser' : 'unknown';
  const system = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return system ? `${browser} on ${system}` : browser;
}


/** Opens a dashboard session for this browser (after a password, a token or a one-time code checked out). */
function openSession(req, via) {
  const at = new Date().toISOString();
  const address = String(req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  const id = crypto.randomBytes(6).toString('hex');
  const sessionToken = 'ahs_' + crypto.randomBytes(24).toString('base64url');
  users.addSession.run(id, sha256(sessionToken), at, at, describeDevice(req.headers['user-agent']), address, via);
  users.logSignIn.run(at, address, via, 1, id);
  users.pruneSessions.run(); // keep the 50 most recent sessions
  users.pruneSignIns.run(); // and the last 1000 sign-in attempts
  return { token: sessionToken, session: id };
}
function tooManyFailures(req) {
  const address = String(req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  if (users.recentFailures.get(address, new Date(Date.now() - 600_000).toISOString()).n >= 20) throw httpError(429, 'too many failed sign-ins from this address: wait a few minutes');
  return address;
}
// What the sign-in page should show: create the account, or sign in
route('GET', '/api/setup', ({ req }) => {
  const hasAccount = users.accountCount.get().n > 0;
  return { hasAccount, canSignUpHere: !hasAccount && isLoopback(req), needsSetupCode: !hasAccount && !isLoopback(req), version: VERSION };
}, { open: true });
route('POST', '/api/signup', async ({ req }) => {
  if (users.accountCount.get().n > 0) throw httpError(409, 'this hub already has its account: sign in instead');
  tooManyFailures(req);
  const { username, password, setupCode: code } = await readJson(req);
  if (!isLoopback(req) && (!setupCode || String(code ?? '').trim().toUpperCase() !== setupCode)) {
    users.logSignIn.run(new Date().toISOString(), String(req.socket.remoteAddress ?? '').replace(/^::ffff:/, ''), 'sign-up', 0, null);
    throw httpError(403, 'create the account on the hub\'s own computer, or enter the setup code the hub printed when it started');
  }
  const name = String(username ?? '').trim();
  if (!/^[\w.@-]{3,40}$/.test(name)) throw httpError(400, 'choose a username of 3-40 letters, digits, . _ - or @');
  if (typeof password !== 'string' || password.length < 8) throw httpError(400, 'choose a password of at least 8 characters');
  if (password.length > 200) throw httpError(400, 'that password is too long');
  const at = new Date().toISOString();
  const { lastInsertRowid } = users.addAccount.run(name, hashPassword(password), at);
  // a hub made before accounts existed: its admin token becomes the account's token
  const old = legacyAdminToken();
  if (old) {
    users.setAccountToken.run(old, sha256(old), at, lastInsertRowid);
    fs.rmSync(ADMIN_FILE, { force: true });
    if (!ENV_ADMIN_TOKEN) users.clearAdmin.run();
  }
  setupCode = null;
  users.loggedIn.run(at, lastInsertRowid);
  return { ...openSession(req, 'password'), username: name };
}, { open: true });
route('POST', '/api/login', async ({ req }) => {
  const address = tooManyFailures(req);
  const { username, password } = await readJson(req);
  const account = users.accountByName.get(String(username ?? '').trim());
  if (!account || typeof password !== 'string' || !checkPassword(password, account.password_hash)) {
    users.logSignIn.run(new Date().toISOString(), address, 'password', 0, null);
    throw httpError(401, 'wrong username or password');
  }
  users.loggedIn.run(new Date().toISOString(), account.id);
  return { ...openSession(req, 'password'), username: account.username };
}, { open: true });
route('GET', '/api/account', ({ me }) => {
  if (!me.admin) throw httpError(403, 'admin only');
  const a = users.firstAccount.get();
  return a ? { username: a.username, created: a.created, lastLogin: a.last_login, hasToken: !!a.token, tokenCreated: a.token_created, fixedToken: !!ENV_ADMIN_TOKEN } : { username: null, fixedToken: !!ENV_ADMIN_TOKEN };
});
// The account's token: one at a time, valid until it is revoked; shown to the signed-in account whenever it asks
route('GET', '/api/account/token', ({ me }) => {
  if (!me.admin) throw httpError(403, 'admin only');
  const a = users.firstAccount.get();
  return { token: a?.token ?? ENV_ADMIN_TOKEN ?? null, created: a?.token_created ?? null, fromEnvironment: !a?.token && !!ENV_ADMIN_TOKEN };
});
route('POST', '/api/account/token', ({ me }) => {
  if (!me.admin) throw httpError(403, 'admin only');
  const a = users.firstAccount.get();
  if (!a) throw httpError(400, 'create the account first');
  if (a.token) throw httpError(409, 'you already have a token: it stays valid until you revoke it');
  const token = newToken();
  const at = new Date().toISOString();
  users.setAccountToken.run(token, sha256(token), at, a.id);
  return { token, created: at };
});
route('DELETE', '/api/account/token', ({ me }) => {
  if (!me.admin) throw httpError(403, 'admin only');
  const a = users.firstAccount.get();
  if (!a?.token) throw httpError(404, 'there is no token to revoke');
  users.setAccountToken.run(null, null, null, a.id);
  return { ok: true };
});
route('POST', '/api/account/password', async ({ me, req }) => {
  if (!me.admin) throw httpError(403, 'admin only');
  const a = users.firstAccount.get();
  if (!a) throw httpError(400, 'create the account first');
  const { current, password } = await readJson(req);
  if (typeof current !== 'string' || !checkPassword(current, a.password_hash)) throw httpError(401, 'the current password is wrong');
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) throw httpError(400, 'choose a password of at least 8 characters');
  users.setPassword.run(hashPassword(password), a.id);
  return { ok: true };
});

route('POST', '/api/sessions', async ({ req }) => {
  const address = String(req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  const now = Date.now();
  // slow down guessing: 20 failed sign-ins per address per 10 minutes
  if (users.recentFailures.get(address, new Date(now - 600_000).toISOString()).n >= 20) throw httpError(429, 'too many failed sign-ins from this address: wait a few minutes');
  const { token, code } = await readJson(req);
  let via = null;
  if (typeof code === 'string' && code) {
    const c = loginCodes.get(code.trim().toUpperCase());
    loginCodes.delete(code.trim().toUpperCase());
    if (c && c.expires > now) via = 'sign-in code';
  } else if (typeof token === 'string' && (users.isAdmin.get(sha256(token.trim())) || users.accountByTokenHash.get(sha256(token.trim())))) via = 'admin token';
  const at = new Date(now).toISOString();
  if (!via) {
    users.logSignIn.run(at, address, code ? 'sign-in code' : 'admin token', 0, null);
    throw httpError(401, code ? 'that sign-in code is wrong or has expired' : 'that is not the admin token');
  }
  return openSession(req, via);
}, { open: true });
route('GET', '/api/sessions', ({ me }) => {
  if (!me.admin) throw httpError(403, 'admin only');
  return { sessions: users.listSessions.all().map((x) => ({ ...x, current: x.id === me.session })) };
});
// Recent sign-in attempts, successful or not: who has been getting in (or trying to)
route('GET', '/api/sign-ins', ({ me }) => {
  if (!me.admin) throw httpError(403, 'admin only');
  return { signIns: users.listSignIns.all().map((x) => ({ ...x, ok: !!x.ok })) };
});
route('DELETE', '/api/sessions/([0-9a-f]+)', ({ me, params }) => {
  if (!me.admin) throw httpError(403, 'admin only');
  if (!users.dropSession.run(params[0]).changes) throw httpError(404, 'no such session');
  return { ok: true };
});
route('POST', '/api/login-codes', ({ me }) => {
  if (!me.admin) throw httpError(403, 'admin only');
  return { code: newLoginCode(), expiresIn: 300 };
});

// ---------- chats: the admin starts group chats and adds or removes their members ----------
function addMember(channel, name) {
  const a = db.agents[name];
  if (!a || a.disabled) throw httpError(404, `no such agent "${name}"`);
  if (a.kind === 'a2a') throw httpError(400, `${name} is a remote A2A agent: message it directly instead`);
  a.removedFrom = (a.removedFrom ?? []).filter((c) => c !== channel);
  if (channel !== '#general') a.channels = [...new Set([...(a.channels ?? []), channel])];
}
route('POST', '/api/chats', async ({ me, req }) => {
  if (!me.admin) throw httpError(403, 'only the admin can start chats');
  const { name, members } = await readJson(req);
  const bare = String(name ?? '').replace(/^#/, '').trim().toLowerCase();
  if (!NAME.test(bare)) throw httpError(400, 'chat names are 1-32 characters: a-z, 0-9, - or _');
  const channel = `#${bare}`;
  if (channel === '#general' || db.chats[channel] || db.messages.some((m) => m.to === channel)) throw httpError(409, `${channel} already exists`);
  const list = [...new Set(Array.isArray(members) ? members : [])];
  if (!list.length) throw httpError(400, 'choose at least one agent');
  for (const n of list) if (!db.agents[n] || db.agents[n].disabled || db.agents[n].kind === 'a2a') throw httpError(400, `"${n}" can't join a chat`);
  db.chats[channel] = { created: new Date().toISOString(), by: me.name };
  for (const n of list) addMember(channel, n);
  save();
  post('hub', { to: channel, kind: 'system', body: `The admin started ${channel} with ${list.map((n) => '@' + n).join(', ')}. Everything posted here is visible to the members of this chat and the admin.` });
  return { channel, members: membersOf(channel) };
});
route('POST', '/api/chats/([a-z0-9_-]+)/members', async ({ me, req, params }) => {
  if (!me.admin) throw httpError(403, 'only the admin can add members');
  const channel = `#${params[0]}`;
  const { name } = await readJson(req);
  if (membersOf(channel).includes(name)) throw httpError(409, `${name} is already in ${channel}`);
  addMember(channel, name);
  save();
  post('hub', { to: channel, kind: 'system', body: `The admin added @${name} to ${channel}.` });
  return { channel, members: membersOf(channel) };
});
route('DELETE', '/api/chats/([a-z0-9_-]+)/members/([a-z0-9_-]+)', ({ me, params }) => {
  if (!me.admin) throw httpError(403, 'only the admin can remove members');
  const [channel, name] = [`#${params[0]}`, params[1]];
  const a = db.agents[name];
  if (!a || !membersOf(channel).includes(name)) throw httpError(404, `${name} is not in ${channel}`);
  a.channels = (a.channels ?? []).filter((c) => c !== channel);
  a.removedFrom = [...new Set([...(a.removedFrom ?? []), channel])];
  save();
  post('hub', { to: channel, kind: 'system', body: `The admin removed ${name} from ${channel}.` });
  post('hub', { to: name, kind: 'system', body: `The admin removed you from ${channel}: you no longer receive its messages. Please stop posting there.` });
  return { channel, members: membersOf(channel) };
});

route('POST', '/api/channels/([a-z0-9_-]+)/(join|leave)', ({ me, params }) => {
  if (me.admin) return { ok: true, note: 'the admin sees every channel' };
  const [channel, action] = [`#${params[0]}`, params[1]];
  const a = db.agents[me.name];
  if (channel === '#general') throw httpError(400, 'everyone is in #general');
  if (action === 'join' && a.removedFrom?.includes(channel)) throw httpError(403, `the admin removed you from ${channel}; ask the admin to add you back`);
  a.channels = action === 'join' ? [...new Set([...a.channels, channel])] : a.channels.filter((c) => c !== channel);
  save();
  return { channels: channelsOf(me.name) };
});

route('POST', '/api/messages', async ({ me, req }) => post(me.name, await readJson(req)));

// Messages visible to me after `since` (optionally in one conversation); `wait` (seconds) long-polls for new ones
route('GET', '/api/messages', ({ me, url, req }) => {
  const since = Number(url.searchParams.get('since') ?? 0) || 0;
  const limit = Math.min(500, Number(url.searchParams.get('limit') ?? 100) || 100);
  const wait = Math.min(60, Math.max(0, Number(url.searchParams.get('wait') ?? 0) || 0));
  const conversation = url.searchParams.get('conversation');
  const matches = (m) => m.id > since && visible(me.name, m) && (!conversation || conversationOf(m) === conversation);
  const found = db.messages.filter(matches).slice(-limit);
  if (found.length || !wait) {
    markSeen(me.name, found);
    return { messages: found };
  }
  return new Promise((resolve) => {
    const w = { name: me.name, push: (m) => matches(m) && done([m]) };
    const timer = setTimeout(() => done([]), wait * 1000);
    let finished = false;
    function done(messages) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      waiters.delete(w);
      release(me.name);
      markSeen(me.name, messages);
      resolve({ messages });
    }
    holdOpen(me.name);
    waiters.add(w);
    req.on('close', () => done([]));
  });
});

// Server-sent events: every new visible message as it arrives
route('GET', '/api/stream', ({ me, req, res }) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
  res.write(': connected\n\n');
  const w = {
    name: me.name,
    push: (m) => {
      res.write(`id: ${m.id}\nevent: message\ndata: ${JSON.stringify(m)}\n\n`);
      setImmediate(() => markSeen(me.name, [m]));
    },
    seen: (receipt) => res.write(`event: seen\ndata: ${JSON.stringify(receipt)}\n\n`),
  };
  waiters.add(w);
  holdOpen(me.name);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(ping);
    waiters.delete(w);
    release(me.name);
  });
  return undefined; // keep the response open
});

// ---------- A2A: the Agent2Agent protocol (https://a2a-protocol.org) ----------
// Inbound: every hub agent has an agent card and a JSON-RPC endpoint (/a2a/<name>). A request becomes a hub message
// to the agent (kind "a2a"); the agent's reply to that message completes the task.
// Outbound: a remote A2A agent registered by the admin (kind "a2a") receives hub messages over A2A, and its answers
// come back as replies.
const A2A_VERSION = '0.3.0';
const TERMINAL = new Set(['completed', 'canceled', 'failed', 'rejected']);
db.a2aTasks ??= {};
const taskByMessage = new Map(); // hub message id -> A2A task id
for (const t of Object.values(db.a2aTasks)) for (const mid of t.hubMessages) taskByMessage.set(mid, t.id);
const taskWatchers = new Map(); // task id -> Set of listeners
const baseUrl = (req) => PUBLIC_URL || `http://${req.headers.host}`;
const textOf = (parts) => (Array.isArray(parts) ? parts.filter((x) => x && typeof x.text === 'string' && (x.kind ?? x.type ?? 'text') === 'text').map((x) => x.text).join('\n') : '');
const agentMessage = (text, t) => ({ kind: 'message', role: 'agent', parts: [{ kind: 'text', text }], messageId: crypto.randomUUID(), taskId: t.id, contextId: t.contextId });

function publicTask(t, historyLength) {
  const history = historyLength === 0 ? [] : historyLength > 0 ? t.history.slice(-historyLength) : t.history;
  return { kind: 'task', id: t.id, contextId: t.contextId, status: t.status, history, artifacts: t.artifacts, metadata: { hub: { agent: t.target, caller: t.caller } } };
}
function setTaskStatus(t, state, message) {
  t.status = { state, ...(message ? { message } : {}), timestamp: new Date().toISOString() };
  if (message) t.history.push(message);
  save();
  for (const fn of [...(taskWatchers.get(t.id) ?? [])]) fn(t);
}
function watchTask(t, fn) {
  if (!taskWatchers.has(t.id)) taskWatchers.set(t.id, new Set());
  taskWatchers.get(t.id).add(fn);
  return () => taskWatchers.get(t.id)?.delete(fn);
}
/** Waits until the task leaves submitted/working, or the time runs out. */
const settled = (t, ms) => new Promise((resolve) => {
  if (!['submitted', 'working'].includes(t.status.state)) return resolve();
  const stop = watchTask(t, (x) => { if (!['submitted', 'working'].includes(x.status.state)) done(); });
  const timer = setTimeout(done, ms);
  function done() { clearTimeout(timer); stop(); resolve(); }
});

function agentCard(name, a, base) {
  return {
    protocolVersion: A2A_VERSION,
    name,
    description: a.description || `${name}, an agent on Agent Hub`,
    url: `${base}/a2a/${name}`,
    preferredTransport: 'JSONRPC',
    version: VERSION,
    provider: { organization: 'Agent Hub', url: base },
    ...(a.avatar ? { iconUrl: `${base}/avatars/${name}` } : {}),
    capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [{ id: 'message', name: `Message ${name}`, description: `Send ${name} a message. The task completes when ${name} replies on the hub, which can take a while: use message/stream or poll tasks/get.`, tags: ['chat', a.kind ?? 'agent'], examples: ['Hello! Could you help me with ...?'] }],
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer', description: 'An Agent Hub agent token (ask the hub admin for one)' } },
    security: [{ bearer: [] }],
  };
}

/** A hub agent answered a message that belongs to an A2A task. */
function a2aReply(m) {
  const t = db.a2aTasks[taskByMessage.get(m.reply_to)];
  if (!t || m.from !== t.target || TERMINAL.has(t.status.state)) return;
  t.hubMessages.push(m.id);
  taskByMessage.set(m.id, t.id);
  const message = agentMessage(m.body, t);
  // The reply's kind can steer the task: "a2a-working" (progress), "a2a-input" (needs input), "a2a-failed"
  if (m.kind === 'a2a-working') return setTaskStatus(t, 'working', message);
  if (m.kind === 'a2a-input') return setTaskStatus(t, 'input-required', message);
  if (m.kind === 'a2a-failed') return setTaskStatus(t, 'failed', message);
  t.artifacts.push({ artifactId: crypto.randomUUID(), name: 'reply', parts: [{ kind: 'text', text: m.body }] });
  setTaskStatus(t, 'completed', message);
}

function pruneTasks() {
  const ids = Object.keys(db.a2aTasks);
  for (const id of ids.slice(0, Math.max(0, ids.length - 2000))) {
    for (const mid of db.a2aTasks[id].hubMessages) taskByMessage.delete(mid);
    delete db.a2aTasks[id];
  }
}

const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

route('GET', '/a2a', ({ req }) => ({
  agents: Object.entries(db.agents).filter(([, a]) => !a.disabled && a.kind !== 'a2a').map(([name, a]) => ({ name, description: a.description, card: `${baseUrl(req)}/a2a/${name}/.well-known/agent-card.json` })),
}), { open: true });

route('GET', '/a2a/([a-z0-9_-]+)/\\.well-known/(agent-card|agent)\\.json', ({ req, params }) => {
  const a = db.agents[params[0]];
  if (!a || a.disabled || a.kind === 'a2a') throw httpError(404, 'no such agent');
  return agentCard(params[0], a, baseUrl(req));
}, { open: true });

route('POST', '/a2a/([a-z0-9_-]+)', async ({ me, req, res, params }) => {
  const target = params[0];
  const a = db.agents[target];
  if (!a || a.disabled) throw httpError(404, 'no such agent');
  let rpc;
  try {
    rpc = await readJson(req);
  } catch {
    return rpcError(null, -32700, 'Parse error');
  }
  const id = rpc?.id ?? null;
  const p = rpc?.params ?? {};
  switch (rpc?.method) {
    case 'message/send':
    case 'message/stream': {
      if (a.kind === 'a2a') return rpcError(id, -32004, `${target} is a remote A2A agent: call its own endpoint`);
      if (target === me.name) return rpcError(id, -32602, 'you cannot send a task to yourself');
      const msg = p.message;
      const text = textOf(msg?.parts);
      if (!text.trim()) return rpcError(id, -32005, 'the message needs at least one text part');
      let t = null;
      if (msg.taskId) {
        t = db.a2aTasks[msg.taskId];
        if (!t || t.caller !== me.name || t.target !== target) return rpcError(id, -32001, 'Task not found');
        if (TERMINAL.has(t.status.state)) return rpcError(id, -32004, `the task is already ${t.status.state}: start a new one`);
      } else {
        t = { id: crypto.randomUUID(), contextId: msg.contextId || crypto.randomUUID(), target, caller: me.name, history: [], artifacts: [], hubMessages: [], status: null, created: new Date().toISOString() };
        db.a2aTasks[t.id] = t;
        pruneTasks();
      }
      t.history.push({ ...msg, kind: 'message', role: 'user', messageId: msg.messageId || crypto.randomUUID(), taskId: t.id, contextId: t.contextId });
      const hubMessage = post(me.name, { to: target, kind: 'a2a', body: text, reply_to: t.hubMessages.at(-1) ?? null });
      t.hubMessages.push(hubMessage.id);
      taskByMessage.set(hubMessage.id, t.id);
      setTaskStatus(t, 'submitted');
      if (rpc.method === 'message/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        const event = (result) => res.write(`data: ${JSON.stringify(rpcResult(id, result))}\n\n`);
        event(publicTask(t));
        const finish = () => { stop(); clearTimeout(limit); clearInterval(ping); res.end(); };
        const stop = watchTask(t, (x) => {
          const final = TERMINAL.has(x.status.state) || x.status.state === 'input-required';
          event({ kind: 'status-update', taskId: x.id, contextId: x.contextId, status: x.status, final });
          if (final) finish();
        });
        const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
        const limit = setTimeout(finish, 15 * 60 * 1000);
        req.on('close', finish);
        return undefined;
      }
      // Blocking by default: wait (up to 55 s) for the agent to answer; otherwise return the task to poll
      if (p.configuration?.blocking !== false) await settled(t, 55_000);
      return rpcResult(id, publicTask(t, p.configuration?.historyLength));
    }
    case 'tasks/get': {
      const t = db.a2aTasks[p.id];
      if (!t || (!me.admin && me.name !== t.caller && me.name !== t.target)) return rpcError(id, -32001, 'Task not found');
      return rpcResult(id, publicTask(t, p.historyLength));
    }
    case 'tasks/cancel': {
      const t = db.a2aTasks[p.id];
      if (!t || (!me.admin && me.name !== t.caller)) return rpcError(id, -32001, 'Task not found');
      if (TERMINAL.has(t.status.state)) return rpcError(id, -32002, `Task cannot be canceled: it is already ${t.status.state}`);
      setTaskStatus(t, 'canceled');
      post('hub', { to: t.target, kind: 'system', reply_to: t.hubMessages.at(-1) ?? null, body: `${t.caller} canceled the A2A request above: no answer is needed any more.` });
      return rpcResult(id, publicTask(t));
    }
    case 'tasks/pushNotificationConfig/set':
    case 'tasks/pushNotificationConfig/get':
      return rpcError(id, -32003, 'Push notifications are not supported: use message/stream or tasks/get');
    default:
      return rpcError(id, -32601, `Method not found: ${rpc?.method}`);
  }
});

// ---------- outbound: remote A2A agents ----------
async function fetchJson(url, init = {}, ms = 15_000) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(ms), redirect: 'follow' });
  const text = await res.text();
  if (text.length > 2 * 1024 * 1024) throw new Error('response too large');
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`not JSON from ${url}`);
  }
}
/** Reads a remote agent's card from its card URL or its base URL. */
async function readCard(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw httpError(400, 'a2aUrl must be the agent card URL or the agent base URL');
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw httpError(400, 'a2aUrl must use http or https');
  const tries = /\.json$/.test(u.pathname) ? [u.href] : ['agent-card.json', 'agent.json'].map((f) => new URL(`.well-known/${f}`, u.href.endsWith('/') ? u.href : u.href + '/').href);
  let last;
  for (const href of tries) {
    try {
      const card = await fetchJson(href, { headers: { accept: 'application/json' } });
      if (!card || typeof card.url !== 'string') throw new Error('the agent card has no "url"');
      return card;
    } catch (e) {
      last = e;
    }
  }
  throw httpError(502, `could not read an agent card: ${last?.message}`);
}
async function registerRemote(name, { url, token, description, product }) {
  const card = await readCard(url);
  const endpoint = new URL(card.url, url).href;
  db.agents[name] = {
    description: String(description || card.description || '').slice(0, 500),
    kind: 'a2a',
    channels: [],
    created: new Date().toISOString(),
    product: product || null,
    a2a: { url: endpoint, cardUrl: url, name: String(card.name ?? '').slice(0, 100), skills: (card.skills ?? []).map((k) => String(k?.name ?? k?.id ?? '')).slice(0, 20), streaming: !!card.capabilities?.streaming, ...(token ? { token: String(token) } : {}), contexts: {} },
  };
  if (product) setAvatar(name, storedImage({ catalog: product }), product);
  save();
  return { name, a2a: { endpoint, agent: db.agents[name].a2a.name, skills: db.agents[name].a2a.skills } };
}
async function a2aCall(remote, method, params) {
  const data = await fetchJson(remote.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...(remote.token ? { authorization: `Bearer ${remote.token}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }),
  }, 70_000);
  if (data.error) throw new Error(`${data.error.message ?? 'error'} (${data.error.code})`);
  return data.result;
}
function a2aText(result) {
  if (!result) return '';
  if (result.kind === 'message' || (result.parts && !result.status)) return textOf(result.parts);
  const fromArtifacts = (result.artifacts ?? []).map((x) => textOf(x.parts)).filter(Boolean).join('\n\n');
  const status = textOf(result.status?.message?.parts);
  const lastAgent = textOf([...(result.history ?? [])].reverse().find((x) => x.role === 'agent')?.parts);
  const text = fromArtifacts || status || lastAgent;
  const state = result.status?.state;
  return state && state !== 'completed' ? `[${state}] ${text}`.trim() : text;
}
/** A hub message to a remote A2A agent: send it over A2A and post the answer back as a reply. */
async function forwardA2A(m) {
  const a = db.agents[m.to];
  const remote = a.a2a;
  const key = [m.from, m.to].sort().join('|');
  remote.contexts ??= {};
  remote.contexts[key] ??= crypto.randomUUID();
  try {
    let result = await a2aCall(remote, 'message/send', {
      message: { kind: 'message', role: 'user', messageId: crypto.randomUUID(), contextId: remote.contexts[key], parts: [{ kind: 'text', text: m.body }], metadata: { agentHub: { from: m.from, messageId: m.id } } },
      configuration: { blocking: true, acceptedOutputModes: ['text/plain'] },
    });
    const deadline = Date.now() + 5 * 60 * 1000;
    while (result?.kind === 'task' && ['submitted', 'working'].includes(result.status?.state) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      result = await a2aCall(remote, 'tasks/get', { id: result.id });
    }
    if (result?.contextId) remote.contexts[key] = result.contextId;
    a.lastSeen = new Date().toISOString();
    save();
    markSeen(m.to, [m]);
    post(m.to, { to: m.from, kind: 'a2a', reply_to: m.id, body: a2aText(result) || '(the A2A agent answered without any text)' });
  } catch (e) {
    post('hub', { to: m.from, kind: 'system', reply_to: m.id, body: `Could not reach the remote A2A agent ${m.to}: ${e.message}` });
  }
}

const UI = fs.readFileSync(path.join(here, 'ui.html'), 'utf8');
const BRIDGE = fs.readFileSync(path.join(here, 'mcp-bridge.mjs'), 'utf8');
const ASSET_TYPES = { '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
/** The dashboard's images, loaded once from ./assets. */
const ASSET_FILES = new Map();
for (const name of fs.readdirSync(path.join(here, 'assets'))) {
  if (ASSET_TYPES[path.extname(name).toLowerCase()]) ASSET_FILES.set(name, fs.readFileSync(path.join(here, 'assets', name)));
}
// Installable web app: the manifest and a service worker that keeps the dashboard's shell for offline starts
const MANIFEST = JSON.stringify({
  name: 'Agent Hub',
  short_name: 'Agent Hub',
  description: 'Where AI agents and their people talk',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#0b1120',
  theme_color: '#0b1120',
  icons: [
    { src: '/assets/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/assets/icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: '/assets/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
});
const SERVICE_WORKER = `// Agent Hub ${VERSION}: keeps the dashboard's shell so the app opens instantly; never caches API calls
const CACHE = 'agent-hub-${VERSION}';
self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/', '/assets/logo-mark.webp'])).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname === '/' || url.pathname.startsWith('/assets/')) {
    e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request)));
  }
});
`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://hub');
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; worker-src 'self'; manifest-src 'self'; connect-src 'self'; img-src 'self' data:",
        'x-frame-options': 'DENY',
        'referrer-policy': 'no-referrer',
      });
      return res.end(UI);
    }
    // Images for the dashboard (only the hub's own, loaded at startup)
    if (req.method === 'GET' && url.pathname.startsWith('/assets/')) {
      const name = decodeURIComponent(url.pathname.slice('/assets/'.length));
      const file = ASSET_FILES.get(name);
      if (!file) throw httpError(404, 'not found');
      res.writeHead(200, { 'content-type': ASSET_TYPES[path.extname(name).toLowerCase()], 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff' });
      return res.end(file);
    }
    if (req.method === 'GET' && url.pathname === '/manifest.webmanifest') {
      res.writeHead(200, { 'content-type': 'application/manifest+json', 'cache-control': 'no-cache' });
      return res.end(MANIFEST);
    }
    if (req.method === 'GET' && url.pathname === '/sw.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache', 'service-worker-allowed': '/' });
      return res.end(SERVICE_WORKER);
    }
    // Shared images and catalogue pictures are public (shared images have unguessable ids)
    const shared = req.method === 'GET' && url.pathname.match(/^\/images\/([0-9a-f]{16})\.(png|jpg|webp)$/);
    const listed = req.method === 'GET' && url.pathname.match(/^\/catalog\/([a-z0-9-]+)$/);
    if (shared || listed) {
      const meta = shared ? db.images[shared[1]] : db.catalog[listed[1]];
      if (!meta || (shared && meta.ext !== shared[2])) throw httpError(404, 'not found');
      res.writeHead(200, { 'content-type': meta.type, 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'" });
      return fs.createReadStream(shared ? path.join(IMAGES, `${shared[1]}.${meta.ext}`) : path.join(CATALOG, `${listed[1]}.${meta.ext}`)).pipe(res);
    }
    // Agents' pictures are public, like the dashboard's own images
    const pic = req.method === 'GET' && url.pathname.match(/^\/avatars\/([a-z0-9_-]+)$/);
    if (pic) {
      const a = db.agents[pic[1]];
      if (!a?.avatar) throw httpError(404, 'not found');
      res.writeHead(200, { 'content-type': a.avatar.type, 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'" });
      return fs.createReadStream(path.join(AVATARS, `${pic[1]}.${a.avatar.ext}`)).pipe(res);
    }
    // The MCP bridge contains no secrets: agents download it from here
    if (req.method === 'GET' && url.pathname === '/mcp-bridge.mjs') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'content-disposition': 'attachment; filename="mcp-bridge.mjs"' });
      return res.end(BRIDGE);
    }
    const r = routes.find((x) => x.method === req.method && x.pattern.test(url.pathname));
    if (!r) throw httpError(404, 'not found');
    const me = r.open ? null : who(req, url);
    if (!r.open && !me) throw httpError(401, 'missing or invalid token');
    if (me) touch(me.name);
    const params = url.pathname.match(r.pattern).slice(1);
    const result = await r.handler({ me, req, res, url, params });
    if (result !== undefined && !res.headersSent) send(res, req.method === 'POST' && url.pathname === '/api/agents' ? 201 : 200, result);
  } catch (e) {
    if (!res.headersSent) send(res, e.status ?? 500, { error: e.status ? e.message : 'internal error' });
    if (!e.status) console.error(e);
  }
});

server.on('error', (e) => {
  if (e.code !== 'EADDRINUSE') throw e;
  console.error(`Port ${PORT} is already in use. Is another hub running? Choose another port with --port.`);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  console.log(`Agent Hub ${VERSION} listening on http://${HOST}:${PORT}${HOST === '127.0.0.1' ? ' (this machine only; use --host 0.0.0.0 or HUB_HOST=0.0.0.0 to open it to the network)' : ''}`);
  console.log(`Data: ${DATA}${HISTORY ? `\nChat history: ${path.resolve(HISTORY)}` : ''}`);
  if (OPEN) {
    const url = `http://127.0.0.1:${PORT}/`;
    const [cmd, cmdArgs] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
    spawn(cmd, cmdArgs, { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => console.log(`Open ${url} in your browser.`)).unref();
  }
});
function shutdown() {
  clearTimeout(saveTimer);
  fs.writeFileSync(STORE, JSON.stringify(db), { mode: 0o600 });
  writeContext();
  usersDb.close();
  process.exit(0);
}
// The desktop app runs the hub as a child process and asks it to stop over IPC (Windows has no SIGTERM)
if (process.send) process.on('message', (m) => m === 'shutdown' && shutdown());
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, shutdown);
