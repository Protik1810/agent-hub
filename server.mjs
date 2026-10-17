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

const VERSION = '1.4.0';
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
  if (from !== 'admin' && from !== 'hub' && recent.length >= RATE) throw httpError(429, `rate limit: ${RATE} messages per minute`);
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
function setAvatar(name, { buf, kind }) {
  const a = db.agents[name];
  for (const ext of ['png', 'jpg', 'webp']) fs.rmSync(path.join(AVATARS, `${name}.${ext}`), { force: true });
  fs.writeFileSync(path.join(AVATARS, `${name}.${kind.ext}`), buf);
  a.avatar = { ext: kind.ext, type: kind.type, updated: Date.now() };
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
  product: a.product ?? null,
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
  const { name, description, kind, product } = await readJson(req);
  if (typeof name !== 'string' || !NAME.test(name) || RESERVED.has(name)) throw httpError(400, 'name must be 1-32 characters: a-z, 0-9, - or _ (and not reserved)');
  if (db.agents[name]) throw httpError(409, `agent "${name}" already exists`);
  if (product !== undefined && product !== null && product !== '' && !db.catalog[product]) throw httpError(400, `unknown product "${product}"`);
  const token = newToken();
  db.agents[name] = {
    tokenHash: sha256(token),
    description: String(description ?? '').slice(0, 500),
    kind: typeof kind === 'string' ? kind.slice(0, 32) : null,
    channels: [],
    created: new Date().toISOString(),
    product: product || null,
  };
  // A known product starts with its picture from the catalogue
  if (product) setAvatar(name, storedImage({ catalog: product }));
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
  return setAvatar(params[0], avatarFrom(await readJson(req, MAX_AVATAR * 1.5)));
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

server.listen(PORT, HOST, () => {
  console.log(`Agent Hub ${VERSION} listening on http://${HOST}:${PORT}${HOST === '127.0.0.1' ? ' (this machine only; set HUB_HOST=0.0.0.0 to open it to the network)' : ''}`);
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => {
  clearTimeout(saveTimer);
  fs.writeFileSync(STORE, JSON.stringify(db), { mode: 0o600 });
  process.exit(0);
});
