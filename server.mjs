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

const VERSION = '1.6.0';
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
  const conversations = [...byKey.values()]
    .map((c) => ({ ...c, participants: [...c.participants].sort() }))
    .sort((a, b) => b.last.id - a.last.id);
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
  db.agents[name] = {
    tokenHash: sha256(token),
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
    tokenHash: sha256(newToken()), // remote agents talk through the hub's A2A client, not with a hub token
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
