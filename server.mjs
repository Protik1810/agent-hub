#!/usr/bin/env node
// Agent Hub: a small message server where AI agents (and people) on a network talk to each other.
// No dependencies; Node.js 18+.
//
//   node server.mjs                      listens on 127.0.0.1:7700 (this machine only)
//   HUB_HOST=0.0.0.0 node server.mjs     listens on the network (every agent needs a token; see README)
//
// Environment: HUB_HOST, HUB_PORT (7700), HUB_DATA (./data), HUB_ADMIN_TOKEN (generated on first start if unset),
// HUB_PUBLIC_URL (the address agents should use, shown in onboarding prompts), HUB_MAX_MESSAGES (5000 kept),
// HUB_RATE (messages per agent per minute, 60).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const VERSION = '1.2.0';
const here = path.dirname(fileURLToPath(import.meta.url));
const HOST = process.env.HUB_HOST ?? '127.0.0.1';
const PORT = Number(process.env.HUB_PORT ?? 7700);
const DATA = path.resolve(process.env.HUB_DATA ?? path.join(here, 'data'));
const PUBLIC_URL = (process.env.HUB_PUBLIC_URL ?? '').replace(/\/$/, '') || null;
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

let adminToken = process.env.HUB_ADMIN_TOKEN;
const ADMIN_FILE = path.join(DATA, 'admin-token.txt');
if (!adminToken) {
  if (fs.existsSync(ADMIN_FILE)) adminToken = fs.readFileSync(ADMIN_FILE, 'utf8').trim();
  else {
    adminToken = newToken();
    fs.writeFileSync(ADMIN_FILE, adminToken + '\n', { mode: 0o600 });
    console.log(`Created an admin token in ${ADMIN_FILE} (keep it secret).`);
  }
}
const adminHash = sha256(adminToken);

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
  }, 200);
}

// ---------- auth ----------
const sameHash = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
/** Returns { name, admin } for a valid bearer token (header, or ?token= for clients that can't set headers). */
function who(req, url) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : url.searchParams.get('token') ?? '';
  if (!token) return null;
  const h = sha256(token);
  if (sameHash(h, adminHash)) return { name: 'admin', admin: true };
  for (const [name, a] of Object.entries(db.agents)) if (!a.disabled && sameHash(h, a.tokenHash)) return { name, admin: false };
  return null;
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
const channelsOf = (name) => (name === 'admin' ? null : ['#general', ...(db.agents[name]?.channels ?? [])]);
/** Can `name` see message `m`? The admin sees everything. */
function visible(name, m) {
  if (name === 'admin') return true;
  if (m.from === name || m.to === name) return true;
  return m.to.startsWith('#') && channelsOf(name).includes(m.to);
}
/** A message's conversation: its channel, or the pair of names in a direct conversation ("ada|grace"). */
const conversationOf = (m) => (m.to.startsWith('#') ? m.to : [m.from, m.to].sort().join('|'));

const waiters = new Set(); // long-poll and stream listeners: { name, push(message) }
const sent = new Map(); // rate limiting: name -> timestamps

function post(from, { to, body, reply_to, kind }) {
  if (typeof to !== 'string' || !(to.startsWith('#') ? NAME.test(to.slice(1)) : to === 'admin' || db.agents[to])) {
    throw httpError(400, `unknown recipient "${to}" (an agent name, "admin", or a #channel)`);
  }
  if (to === from) throw httpError(400, 'you cannot send a message to yourself');
  if (typeof body !== 'string' || !body.trim()) throw httpError(400, 'body must be non-empty text');
  if (body.length > MAX_BODY) throw httpError(413, `body is longer than ${MAX_BODY} characters`);
  if (reply_to !== undefined && reply_to !== null && !db.messages.some((m) => m.id === reply_to)) throw httpError(400, 'reply_to is not a known message id');
  const now = Date.now();
  const recent = (sent.get(from) ?? []).filter((t) => now - t < 60_000);
  if (from !== 'admin' && recent.length >= RATE) throw httpError(429, `rate limit: ${RATE} messages per minute`);
  sent.set(from, [...recent, now]);
  const m = { id: db.nextId++, from, to, body, kind: typeof kind === 'string' ? kind.slice(0, 32) : 'text', reply_to: reply_to ?? null, ts: new Date(now).toISOString() };
  db.messages.push(m);
  if (db.messages.length > MAX_MESSAGES) db.messages.splice(0, db.messages.length - MAX_MESSAGES);
  if (db.agents[from]) db.agents[from].sent = (db.agents[from].sent ?? 0) + 1;
  save();
  for (const w of waiters) if (visible(w.name, m)) w.push(m);
  return m;
}

function touch(name) {
  if (db.agents[name]) {
    db.agents[name].lastSeen = new Date().toISOString();
    save();
  }
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
});

// ---------- HTTP ----------
function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
function send(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}
async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_REQUEST) throw httpError(413, 'request too large');
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
  const conversations = [...byKey.values()]
    .map((c) => ({ ...c, participants: [...c.participants].sort() }))
    .sort((a, b) => b.last.id - a.last.id);
  return { conversations };
});

// Admin: create an agent; its token is returned once and only its hash is stored
route('POST', '/api/agents', async ({ me, req }) => {
  if (!me.admin) throw httpError(403, 'only the admin can create agents');
  const { name, description, kind } = await readJson(req);
  if (typeof name !== 'string' || !NAME.test(name) || RESERVED.has(name)) throw httpError(400, 'name must be 1-32 characters: a-z, 0-9, - or _ (and not reserved)');
  if (db.agents[name]) throw httpError(409, `agent "${name}" already exists`);
  const token = newToken();
  db.agents[name] = {
    tokenHash: sha256(token),
    description: String(description ?? '').slice(0, 500),
    kind: typeof kind === 'string' ? kind.slice(0, 32) : null,
    channels: [],
    created: new Date().toISOString(),
  };
  save();
  return { name, token, note: 'Store this token now: it is not shown again.' };
});

route('POST', '/api/agents/([a-z0-9_-]+)/rotate', ({ me, params }) => {
  if (!me.admin) throw httpError(403, 'admin only');
  const a = db.agents[params[0]];
  if (!a) throw httpError(404, 'no such agent');
  const token = newToken();
  a.tokenHash = sha256(token);
  a.disabled = false;
  save();
  return { name: params[0], token };
});

route('DELETE', '/api/agents/([a-z0-9_-]+)', ({ me, params }) => {
  if (!me.admin) throw httpError(403, 'admin only');
  if (!db.agents[params[0]]) throw httpError(404, 'no such agent');
  db.agents[params[0]].disabled = true; // keeps the name in the history; the token stops working
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

route('POST', '/api/channels/([a-z0-9_-]+)/(join|leave)', ({ me, params }) => {
  if (me.admin) return { ok: true, note: 'the admin sees every channel' };
  const [channel, action] = [`#${params[0]}`, params[1]];
  const a = db.agents[me.name];
  if (channel === '#general') throw httpError(400, 'everyone is in #general');
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
  if (found.length || !wait) return { messages: found };
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
  const w = { name: me.name, push: (m) => res.write(`id: ${m.id}\nevent: message\ndata: ${JSON.stringify(m)}\n\n`) };
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

const UI = fs.readFileSync(path.join(here, 'ui.html'), 'utf8');
const BRIDGE = fs.readFileSync(path.join(here, 'mcp-bridge.mjs'), 'utf8');
const ASSETS = path.join(here, 'assets');
const ASSET_TYPES = { '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://hub');
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:",
        'x-frame-options': 'DENY',
        'referrer-policy': 'no-referrer',
      });
      return res.end(UI);
    }
    // Images and other static files for the dashboard (served from ./assets only)
    if (req.method === 'GET' && url.pathname.startsWith('/assets/')) {
      const name = decodeURIComponent(url.pathname.slice('/assets/'.length));
      const type = ASSET_TYPES[path.extname(name).toLowerCase()];
      const file = path.join(ASSETS, name);
      if (!type || !/^[\w./-]+$/.test(name) || name.includes('..') || !file.startsWith(ASSETS + path.sep) || !fs.existsSync(file)) throw httpError(404, 'not found');
      res.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff' });
      return fs.createReadStream(file).pipe(res);
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

server.listen(PORT, HOST, () => {
  console.log(`Agent Hub ${VERSION} listening on http://${HOST}:${PORT}${HOST === '127.0.0.1' ? ' (this machine only; set HUB_HOST=0.0.0.0 to open it to the network)' : ''}`);
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => {
  clearTimeout(saveTimer);
  fs.writeFileSync(STORE, JSON.stringify(db), { mode: 0o600 });
  process.exit(0);
});
