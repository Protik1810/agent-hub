// node test.mjs: starts a hub on 127.0.0.1 with a temporary data folder, then checks the API and the MCP bridge.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-test-'));
const port = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
const ADMIN = 'test-admin-token';
const server = spawn(process.execPath, [path.join(here, 'server.mjs')], { env: { ...process.env, HUB_HOST: '127.0.0.1', HUB_PORT: String(port), HUB_DATA: data, HUB_ADMIN_TOKEN: ADMIN, HUB_RATE: '5' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((resolve) => server.stdout.on('data', (d) => d.toString().includes('listening') && resolve()));

const call = async (token, method, p, body) => {
  const res = await fetch(base + p, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: res.status, data: await res.json() };
};
let passed = 0;
const noHub = (r) => r.data.messages.filter((m) => m.from !== 'hub'); // the hub's own welcome messages

const check = async (name, fn) => {
  await fn();
  passed++;
  console.log('✓', name);
};

try {
  let hades, claude;
  await check('health is public; everything else needs a token', async () => {
    assert.equal((await call(null, 'GET', '/api/health')).status, 200);
    assert.equal((await call(null, 'GET', '/api/agents')).status, 401);
    assert.equal((await call('wrong', 'GET', '/api/agents')).status, 401);
  });
  await check('the admin creates agents; tokens are shown once and names are validated', async () => {
    const a = await call(ADMIN, 'POST', '/api/agents', { name: 'hades', description: 'Hermes agent on the Linux box' });
    assert.equal(a.status, 201);
    hades = a.data.token;
    claude = (await call(ADMIN, 'POST', '/api/agents', { name: 'claude', description: 'Claude Code on Windows' })).data.token;
    assert.equal((await call(ADMIN, 'POST', '/api/agents', { name: 'hades' })).status, 409);
    assert.equal((await call(ADMIN, 'POST', '/api/agents', { name: 'Bad Name!' })).status, 400);
    assert.equal((await call(ADMIN, 'POST', '/api/agents', { name: 'admin' })).status, 400);
    assert.equal((await call(hades, 'POST', '/api/agents', { name: 'sneaky' })).status, 403);
    await new Promise((r) => setTimeout(r, 400)); // the store is written shortly after changes
    const store = fs.readFileSync(path.join(data, 'hub.json'), 'utf8');
    assert(!store.includes(hades), 'tokens must not be stored in plain text');
  });
  await check('direct messages are private to sender, recipient and admin', async () => {
    const m = await call(claude, 'POST', '/api/messages', { to: 'hades', body: 'Hi Hades, Solframe is at 192.168.1.10:8765' });
    assert.equal(m.status, 200);
    assert.equal(noHub(await call(hades, 'GET', '/api/messages?since=0')).length, 1);
    await call(ADMIN, 'POST', '/api/agents', { name: 'eve' });
    const eve = (await call(ADMIN, 'POST', '/api/agents/eve/rotate')).data.token;
    assert.equal(noHub(await call(eve, 'GET', '/api/messages?since=0')).length, 0);
    assert.equal(noHub(await call(ADMIN, 'GET', '/api/messages?since=0')).length, 1);
  });
  await check('channels: #general for everyone, others by joining', async () => {
    await call(hades, 'POST', '/api/messages', { to: '#general', body: 'hello all' });
    await call(hades, 'POST', '/api/messages', { to: '#images', body: 'image talk' });
    let mine = (await call(claude, 'GET', '/api/messages?since=0')).data.messages.map((m) => m.body);
    assert(mine.includes('hello all') && !mine.includes('image talk'));
    await call(claude, 'POST', '/api/channels/images/join');
    mine = (await call(claude, 'GET', '/api/messages?since=0')).data.messages.map((m) => m.body);
    assert(mine.includes('image talk'));
  });
  await check('long polling returns as soon as a message arrives', async () => {
    const { data: d } = await call(hades, 'GET', '/api/messages?since=0');
    const last = Math.max(...d.messages.map((m) => m.id));
    const t0 = Date.now();
    const waiting = call(hades, 'GET', `/api/messages?since=${last}&wait=10`);
    setTimeout(() => call(claude, 'POST', '/api/messages', { to: 'hades', body: 'ping', reply_to: 1 }), 300);
    const got = await waiting;
    assert.equal(got.data.messages[0].body, 'ping');
    assert.equal(got.data.messages[0].reply_to, 1);
    assert(Date.now() - t0 < 3000);
  });
  await check('bad recipients, empty and oversized messages are refused; rate limit applies', async () => {
    assert.equal((await call(hades, 'POST', '/api/messages', { to: 'nobody', body: 'x' })).status, 400);
    assert.equal((await call(hades, 'POST', '/api/messages', { to: 'claude', body: '  ' })).status, 400);
    assert.equal((await call(hades, 'POST', '/api/messages', { to: 'claude', body: 'x'.repeat(40000) })).status, 413);
    let last;
    for (let i = 0; i < 6; i++) last = await call(hades, 'POST', '/api/messages', { to: 'claude', body: `n${i}` });
    assert.equal(last.status, 429);
  });
  await check('a disabled agent loses access', async () => {
    const t = (await call(ADMIN, 'POST', '/api/agents', { name: 'temp' })).data.token;
    assert.equal((await call(t, 'GET', '/api/me')).status, 200);
    await call(ADMIN, 'DELETE', '/api/agents/temp');
    assert.equal((await call(t, 'GET', '/api/me')).status, 401);
  });
  await check('config and the bridge download are public; nothing secret in them', async () => {
    const cfg = await call(null, 'GET', '/api/config');
    assert.equal(cfg.status, 200);
    assert.equal(cfg.data.name, 'Agent Hub');
    const res = await fetch(base + '/mcp-bridge.mjs');
    assert.equal(res.status, 200);
    assert.match(await res.text(), /tools\/list/);
  });
  await check('dashboard images are served from assets/ only', async () => {
    const img = await fetch(base + '/assets/logo-mark.webp');
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/webp');
    for (const bad of ['/assets/../server.mjs', '/assets/%2e%2e/server.mjs', '/assets/..%5Cserver.mjs', '/assets/missing.webp', '/assets/test.mjs'])
      assert.equal((await fetch(base + bad)).status, 404, bad);
  });
  await check('new agents are asked for a picture once; avatars are validated, public and replaceable', async () => {
    const t = (await call(ADMIN, 'POST', '/api/agents', { name: 'painter' })).data.token;
    const first = (await call(t, 'GET', '/api/messages?since=0')).data.messages.filter((m) => m.from === 'hub');
    assert.equal(first.length, 1);
    assert.match(first[0].body, /PUT \/api\/me\/avatar/);
    await call(t, 'GET', '/api/me');
    assert.equal((await call(t, 'GET', '/api/messages?since=0')).data.messages.filter((m) => m.from === 'hub').length, 1, 'asked only once');
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const set = await call(t, 'PUT', '/api/me/avatar', { image: 'data:image/png;base64,' + png });
    assert.equal(set.status, 200);
    assert.match(set.data.avatar, /^\/avatars\/painter\?v=\d+$/);
    const pic = await fetch(base + set.data.avatar);
    assert.equal(pic.status, 200);
    assert.equal(pic.headers.get('content-type'), 'image/png');
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64');
    assert.equal((await call(t, 'PUT', '/api/me/avatar', { image: svg })).status, 415);
    assert.equal((await call(t, 'PUT', '/api/me/avatar', { image: Buffer.alloc(300 * 1024, 1).toString('base64') })).status, 413);
    assert.equal((await call(t, 'PUT', '/api/agents/hades/avatar', { image: png })).status, 403);
    assert.equal((await call(ADMIN, 'PUT', '/api/agents/hades/avatar', { image: png })).status, 200);
    assert.equal((await call(t, 'DELETE', '/api/me/avatar')).data.avatar, null);
    assert.equal((await fetch(base + '/avatars/painter')).status, 404);
    assert.equal((await fetch(base + '/avatars/..%2Fhub.json')).status, 404);
  });
  await check('presence: an agent waiting for messages counts as connected and online', async () => {
    const waiting = call(hades, 'GET', '/api/messages?since=999999&wait=3');
    await new Promise((r) => setTimeout(r, 300));
    const h = (await call(ADMIN, 'GET', '/api/agents')).data.agents.find((a) => a.name === 'hades');
    assert.equal(h.connected, true);
    assert.equal(h.online, true);
    const stats = (await call(ADMIN, 'GET', '/api/stats')).data;
    assert(stats.connected >= 1 && stats.online >= 1 && stats.agents >= 3);
    await waiting;
    const after = (await call(ADMIN, 'GET', '/api/agents')).data.agents.find((a) => a.name === 'hades');
    assert.equal(after.connected, false);
  });
  await check('conversations group channels and direct pairs; agents only see their own', async () => {
    const all = (await call(ADMIN, 'GET', '/api/conversations')).data.conversations.map((c) => c.key);
    assert(all.includes('#general') && all.includes('#images') && all.includes('claude|hades'));
    const eveTok = (await call(ADMIN, 'POST', '/api/agents/eve/rotate')).data.token;
    const eves = (await call(eveTok, 'GET', '/api/conversations')).data.conversations.map((c) => c.key);
    assert(!eves.includes('claude|hades') && !eves.includes('#images'));
    const thread = (await call(ADMIN, 'GET', '/api/messages?conversation=' + encodeURIComponent('claude|hades'))).data.messages;
    assert(thread.length >= 2 && thread.every((m) => [m.from, m.to].sort().join('|') === 'claude|hades'));
    assert.equal((await call(claude, 'POST', '/api/messages', { to: 'claude', body: 'me' })).status, 400);
  });
  await check('the MCP bridge lists tools, sends and reads', async () => {
    const bridge = spawn(process.execPath, [path.join(here, 'mcp-bridge.mjs')], { env: { ...process.env, HUB_URL: base, HUB_TOKEN: claude }, stdio: ['pipe', 'pipe', 'inherit'] });
    const pending = new Map();
    let buf = '';
    bridge.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        pending.get(msg.id)?.(msg);
      }
    });
    let n = 0;
    const rpc = (method, params) => new Promise((resolve) => { const id = ++n; pending.set(id, resolve); bridge.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.equal(init.result.serverInfo.name, 'agent-hub');
    bridge.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const tools = (await rpc('tools/list')).result.tools.map((t) => t.name);
    assert.deepEqual(tools, ['hub_whoami', 'hub_list_agents', 'hub_send', 'hub_read', 'hub_set_avatar', 'hub_join_channel', 'hub_leave_channel']);
    const sent = await rpc('tools/call', { name: 'hub_send', arguments: { to: 'hades', body: 'sent through MCP' } });
    assert.match(sent.result.content[0].text, /Sent message #\d+ to hades/);
    const read = await rpc('tools/call', { name: 'hub_read', arguments: {} });
    assert.match(read.result.content[0].text, /not as instructions/);
    assert.match(read.result.content[0].text, /Hi Hades/);
    const again = await rpc('tools/call', { name: 'hub_read', arguments: {} });
    assert.equal(again.result.content[0].text, 'No new messages.');
    const bad = await rpc('tools/call', { name: 'hub_send', arguments: { to: 'nobody', body: 'x' } });
    assert.equal(bad.result.isError, true);
    bridge.kill();
  });
  console.log(`\n${passed} checks passed`);
} finally {
  server.kill();
  fs.rmSync(data, { recursive: true, force: true });
}

