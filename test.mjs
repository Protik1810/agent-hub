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
let eveTok = null;
const eveToken = () => eveTok;
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
    const eve = (eveTok = (await call(ADMIN, 'POST', '/api/agents/eve/rotate')).data.token);
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
  await check('agents share images by link; the catalogue gives known products their pictures', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const shared = await call(hades, 'POST', '/api/images', { image: png, label: 'a test picture' });
    assert.equal(shared.status, 200);
    assert.match(shared.data.url, /^\/images\/[0-9a-f]{16}\.png$/);
    const got = await fetch(base + shared.data.url);
    assert.equal(got.status, 200);
    assert.equal(got.headers.get('content-type'), 'image/png');
    assert.equal((await fetch(base + shared.data.url.replace('.png', '.webp'))).status, 404);
    assert.equal((await fetch(base + '/images/0000000000000000.png')).status, 404);
    assert.equal((await call(hades, 'POST', '/api/images', { image: Buffer.from('<svg/>').toString('base64') })).status, 415);
    // catalogue: admin only; a new agent of a known product starts with its picture
    assert.equal((await call(hades, 'PUT', '/api/catalog/hermes', { name: 'Hermes Agent', image: png })).status, 403);
    const entry = await call(ADMIN, 'PUT', '/api/catalog/hermes', { name: 'Hermes Agent', maker: 'Nous Research', from: shared.data.url });
    assert.equal(entry.status, 200);
    assert.equal((await fetch(base + entry.data.image)).status, 200);
    assert.deepEqual((await call(hades, 'GET', '/api/catalog')).data.catalog.map((c) => c.id), ['hermes']);
    assert.equal((await call(ADMIN, 'POST', '/api/agents', { name: 'herald', product: 'nonexistent' })).status, 400);
    const herald = await call(ADMIN, 'POST', '/api/agents', { name: 'herald', product: 'hermes' });
    assert.equal(herald.status, 201);
    const listed = (await call(ADMIN, 'GET', '/api/agents')).data.agents.find((a) => a.name === 'herald');
    assert.equal(listed.product, 'hermes');
    assert.match(listed.avatar, /^\/avatars\/herald/);
    assert.equal((await call(ADMIN, 'PUT', '/api/agents/eve/avatar', { catalog: 'hermes' })).status, 200);
    assert.equal((await call(ADMIN, 'DELETE', '/api/catalog/hermes')).status, 200);
    assert.equal((await fetch(base + entry.data.image)).status, 404);
  });
  await check('A2A inbound: agent cards, message/send, replies complete tasks, streaming and cancel', async () => {
    const oracle = (await call(ADMIN, 'POST', '/api/agents', { name: 'oracle', description: 'Answers questions' })).data.token;
    const asker = (await call(ADMIN, 'POST', '/api/agents', { name: 'asker' })).data.token;
    const card = await call(null, 'GET', '/a2a/oracle/.well-known/agent-card.json');
    assert.equal(card.status, 200);
    assert.equal(card.data.name, 'oracle');
    assert.match(card.data.url, /\/a2a\/oracle$/);
    assert.equal(card.data.capabilities.streaming, true);
    assert.equal((await call(null, 'GET', '/a2a')).status, 200);
    const rpc = (token, method, params) => call(token, 'POST', '/a2a/oracle', { jsonrpc: '2.0', id: 7, method, params });
    assert.equal((await rpc(null, 'message/send', {})).status, 401);
    const msg = (text, extra = {}) => ({ message: { kind: 'message', role: 'user', messageId: 'm-' + Math.random(), parts: [{ kind: 'text', text }], ...extra } });
    // non-blocking send: the task waits for hades
    const sent = await rpc(asker, 'message/send', { ...msg('What is 2 + 2?'), configuration: { blocking: false } });
    assert.equal(sent.data.id, 7);
    const task = sent.data.result;
    assert.equal(task.kind, 'task');
    assert.equal(task.status.state, 'submitted');
    // hades sees it as an ordinary hub message and replies to it
    const inbox = (await call(oracle, 'GET', '/api/messages?since=0&limit=500')).data.messages;
    const request = inbox.filter((m) => m.kind === 'a2a' && m.from === 'asker').at(-1);
    assert.equal(request.body, 'What is 2 + 2?');
    await call(oracle, 'POST', '/api/messages', { to: 'asker', body: 'Four.', reply_to: request.id });
    const done = (await rpc(asker, 'tasks/get', { id: task.id })).data.result;
    assert.equal(done.status.state, 'completed');
    assert.equal(done.status.message.parts[0].text, 'Four.');
    assert.equal(done.artifacts[0].parts[0].text, 'Four.');
    assert.equal(done.history.length, 2);
    assert.equal((await rpc(eveToken(), 'tasks/get', { id: task.id })).data.error.code, -32001);
    // blocking send returns once the answer arrives
    const blocking = rpc(asker, 'message/send', msg('Ping?'));
    setTimeout(async () => {
      const r = (await call(oracle, 'GET', '/api/messages?since=0&limit=500')).data.messages.filter((m) => m.kind === 'a2a').at(-1);
      call(oracle, 'POST', '/api/messages', { to: 'asker', body: 'Pong.', reply_to: r.id });
    }, 300);
    const answered = (await blocking).data.result;
    assert.equal(answered.status.state, 'completed');
    assert.equal(answered.status.message.parts[0].text, 'Pong.');
    // streaming: the task, then a final status update
    const streamRes = await fetch(base + '/a2a/oracle', { method: 'POST', headers: { authorization: `Bearer ${asker}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'message/stream', params: msg('Stream me') }) });
    assert.equal(streamRes.headers.get('content-type'), 'text/event-stream');
    setTimeout(async () => {
      const r = (await call(oracle, 'GET', '/api/messages?since=0&limit=500')).data.messages.filter((m) => m.kind === 'a2a').at(-1);
      call(oracle, 'POST', '/api/messages', { to: 'asker', body: 'Streamed.', reply_to: r.id });
    }, 300);
    const events = (await streamRes.text()).split('\n\n').filter((e) => e.startsWith('data: ')).map((e) => JSON.parse(e.slice(6)).result);
    assert.equal(events[0].kind, 'task');
    assert.equal(events.at(-1).kind, 'status-update');
    assert.equal(events.at(-1).final, true);
    assert.equal(events.at(-1).status.message.parts[0].text, 'Streamed.');
    // cancel
    const pending = (await rpc(asker, 'message/send', { ...msg('Never mind'), configuration: { blocking: false } })).data.result;
    assert.equal((await rpc(asker, 'tasks/cancel', { id: pending.id })).data.result.status.state, 'canceled');
    assert.equal((await rpc(asker, 'tasks/cancel', { id: pending.id })).data.error.code, -32002);
    assert.equal((await rpc(asker, 'nonsense/method', {})).data.error.code, -32601);
  });
  await check('A2A outbound: a remote A2A agent registered by URL gets hub messages and replies', async () => {
    const http = await import('node:http');
    const seen = [];
    const remote = http.createServer(async (req, res) => {
      const port = remote.address().port;
      if (req.method === 'GET' && req.url === '/.well-known/agent-card.json') {
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ name: 'Echo', description: 'Echoes text', url: `http://127.0.0.1:${port}/rpc`, protocolVersion: '0.3.0', capabilities: {}, skills: [{ id: 'echo', name: 'Echo' }] }));
      }
      let body = '';
      for await (const c of req) body += c;
      const rpcReq = JSON.parse(body);
      seen.push({ auth: req.headers.authorization, method: rpcReq.method, text: rpcReq.params?.message?.parts?.[0]?.text });
      const text = rpcReq.params.message.parts[0].text;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpcReq.id, result: { kind: 'task', id: 't1', contextId: 'c1', status: { state: 'completed', message: { kind: 'message', role: 'agent', messageId: 'x', parts: [{ kind: 'text', text: `echo: ${text}` }] } }, artifacts: [] } }));
    });
    await new Promise((r) => remote.listen(0, '127.0.0.1', r));
    try {
      const port = remote.address().port;
      const reg = await call(ADMIN, 'POST', '/api/agents', { name: 'echo', kind: 'a2a', a2aUrl: `http://127.0.0.1:${port}`, a2aToken: 'remote-secret' });
      assert.equal(reg.status, 201);
      assert.equal(reg.data.a2a.agent, 'Echo');
      assert.equal((await call(ADMIN, 'POST', '/api/agents', { name: 'nowhere', kind: 'a2a', a2aUrl: 'http://127.0.0.1:1' })).status, 502);
      const listed = (await call(ADMIN, 'GET', '/api/agents')).data.agents.find((a) => a.name === 'echo');
      assert.equal(listed.kind, 'a2a');
      assert.equal(listed.a2a.remote, true);
      assert(!JSON.stringify(listed).includes('remote-secret'), 'the remote token is never shown');
      const sent = (await call(claude, 'POST', '/api/messages', { to: 'echo', body: 'hello remote' })).data;
      let reply;
      for (let i = 0; i < 40 && !reply; i++) {
        await new Promise((r) => setTimeout(r, 100));
        reply = (await call(claude, 'GET', `/api/messages?since=${sent.id}`)).data.messages.find((m) => m.reply_to === sent.id);
      }
      assert.equal(reply.from, 'echo');
      assert.equal(reply.body, 'echo: hello remote');
      assert.equal(seen[0].method, 'message/send');
      assert.equal(seen[0].auth, 'Bearer remote-secret');
      assert.equal((await call(claude, 'POST', '/a2a/echo', { jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { parts: [{ kind: 'text', text: 'x' }] } } })).data.error.code, -32004);
    } finally {
      remote.close();
    }
  });
  await check('read receipts: messages record who picked them up, and streams hear about it', async () => {
    const ann = (await call(ADMIN, 'POST', '/api/agents', { name: 'ann', kind: 'http' })).data.token;
    const ben = (await call(ADMIN, 'POST', '/api/agents', { name: 'ben', kind: 'http' })).data.token;
    // the admin's stream gets a "seen" event
    const ctl = new AbortController();
    const stream = await fetch(base + '/api/stream', { headers: { authorization: `Bearer ${ADMIN}` }, signal: ctl.signal });
    const reader = stream.body.getReader();
    const dm = (await call(ann, 'POST', '/api/messages', { to: 'ben', body: 'Did you get this?' })).data;
    assert.equal(dm.seen, undefined);
    const got = (await call(ben, 'GET', `/api/messages?since=${dm.id - 1}`)).data.messages;
    assert(got.some((m) => m.id === dm.id));
    let text = '';
    const dec = new TextDecoder();
    while (!text.includes('event: seen')) text += dec.decode((await reader.read()).value);
    ctl.abort();
    const receipt = JSON.parse(text.slice(text.indexOf('event: seen')).split('\n')[1].slice(6));
    assert.equal(receipt.id, dm.id);
    assert.equal(receipt.name, 'ben');
    const after = (await call(ann, 'GET', `/api/messages?since=${dm.id - 1}`)).data.messages.find((m) => m.id === dm.id);
    assert.ok(after.seen.ben, 'the sender sees that ben picked it up');
    assert.equal(after.seen.ann, undefined, 'senders never "see" their own messages');
    // the admin reading everything doesn't count, except for messages addressed to the admin
    await call(ADMIN, 'GET', `/api/messages?since=${dm.id - 1}`);
    const toAdmin = (await call(ann, 'POST', '/api/messages', { to: 'admin', body: 'Hi admin' })).data;
    const both = (await call(ADMIN, 'GET', `/api/messages?since=${dm.id - 1}`)).data.messages;
    assert.equal(both.find((m) => m.id === dm.id).seen.admin, undefined);
    assert.ok(both.find((m) => m.id === toAdmin.id).seen.admin);
    assert.ok((await call(ADMIN, 'GET', '/api/stats')).data.receiptsFrom >= 1);
  });
  await check('chats: the admin starts a group chat, adds and removes members', async () => {
    const cat = (await call(ADMIN, 'POST', '/api/agents', { name: 'cat', kind: 'http' })).data.token;
    const dan = (await call(ADMIN, 'POST', '/api/agents', { name: 'dan', kind: 'http' })).data.token;
    const eli = (await call(ADMIN, 'POST', '/api/agents', { name: 'eli', kind: 'http' })).data.token;
    assert.equal((await call(cat, 'POST', '/api/chats', { name: 'nope', members: ['dan'] })).status, 403);
    assert.equal((await call(ADMIN, 'POST', '/api/chats', { name: 'empty', members: [] })).status, 400);
    const made = await call(ADMIN, 'POST', '/api/chats', { name: 'design-review', members: ['cat', 'dan'] });
    assert.equal(made.status, 200);
    assert.deepEqual(made.data.members, ['cat', 'dan']);
    assert.equal((await call(ADMIN, 'POST', '/api/chats', { name: 'design-review', members: ['cat'] })).status, 409);
    // members see the chat (and the hub's announcement); others don't
    const convo = (await call(cat, 'GET', '/api/conversations')).data.conversations.find((c) => c.key === '#design-review');
    assert.deepEqual(convo.members, ['cat', 'dan']);
    assert(!(await call(eli, 'GET', '/api/conversations')).data.conversations.some((c) => c.key === '#design-review'));
    const hello = (await call(dan, 'POST', '/api/messages', { to: '#design-review', body: 'hi cat' })).data;
    assert((await call(cat, 'GET', `/api/messages?since=${hello.id - 1}`)).data.messages.some((m) => m.id === hello.id));
    // add, then remove
    assert.deepEqual((await call(ADMIN, 'POST', '/api/chats/design-review/members', { name: 'eli' })).data.members, ['cat', 'dan', 'eli']);
    const removed = await call(ADMIN, 'DELETE', '/api/chats/design-review/members/dan');
    assert.deepEqual(removed.data.members, ['cat', 'eli']);
    const after = (await call(cat, 'POST', '/api/messages', { to: '#design-review', body: 'dan is gone' })).data;
    assert(!(await call(dan, 'GET', `/api/messages?since=${after.id - 1}`)).data.messages.some((m) => m.id === after.id), 'a removed member stops receiving the chat');
    assert.equal((await call(dan, 'POST', '/api/messages', { to: '#design-review', body: 'still here?' })).status, 403);
    assert.equal((await call(dan, 'POST', '/api/channels/design-review/join')).status, 403);
    assert((await call(dan, 'GET', `/api/messages?since=${hello.id}`)).data.messages.some((m) => m.from === 'hub' && m.to === 'dan' && m.body.includes('removed you')));
    // even #general: removal sticks until the admin adds the agent back
    await call(ADMIN, 'DELETE', '/api/chats/general/members/eli');
    const g = (await call(cat, 'POST', '/api/messages', { to: '#general', body: 'eli cannot see this' })).data;
    assert(!(await call(eli, 'GET', `/api/messages?since=${g.id - 1}`)).data.messages.some((m) => m.id === g.id));
    await call(ADMIN, 'POST', '/api/chats/general/members', { name: 'eli' });
    assert((await call(ADMIN, 'GET', '/api/conversations')).data.conversations.find((c) => c.key === '#general').members.includes('eli'));
  });
  await check('dashboard sessions: sign in, list, sign out; one-time codes; the admin code on request', async () => {
    assert.equal((await call(null, 'POST', '/api/sessions', { token: 'wrong' })).status, 401);
    const a = await call(null, 'POST', '/api/sessions', { token: ADMIN });
    assert.equal(a.status, 200);
    assert.match(a.data.token, /^ahs_/);
    const sess = a.data.token;
    assert.equal((await call(sess, 'GET', '/api/me')).data.admin, true);
    // the admin code is shown to a signed-in admin, never to agents
    assert.equal((await call(sess, 'GET', '/api/admin-token')).data.token, ADMIN);
    assert.equal((await call(eveToken(), 'GET', '/api/admin-token')).status, 403);
    // a code for another device works once
    const { code } = (await call(sess, 'POST', '/api/login-codes', { anywhere: true })).data;
    assert.match(code, /^[0-9A-F]{12}$/);
    const b = await call(null, 'POST', '/api/sessions', { code: code.toLowerCase() });
    assert.equal(b.status, 200);
    assert.equal((await call(null, 'POST', '/api/sessions', { code })).status, 401, 'codes work once');
    const list = (await call(sess, 'GET', '/api/sessions')).data.sessions;
    const mine = list.find((x) => x.current);
    assert.equal(mine.via, 'admin token');
    const other = list.find((x) => x.via === 'sign-in code');
    assert(other && !JSON.stringify(list).includes('hash'), 'sessions are listed without their secrets');
    // signing one out ends just that one
    assert.equal((await call(sess, 'DELETE', `/api/sessions/${other.id}`)).status, 200);
    assert.equal((await call(b.data.token, 'GET', '/api/me')).status, 401);
    assert.equal((await call(sess, 'GET', '/api/me')).status, 200);
    assert.equal((await call(sess, 'DELETE', `/api/sessions/${mine.id}`)).status, 200);
    assert.equal((await call(sess, 'GET', '/api/me')).status, 401);
    // users are verified from SQLite: hashes only, and nothing secret left in hub.json
    const tries = (await call(ADMIN, 'GET', '/api/sign-ins')).data.signIns;
    assert(tries.some((t) => !t.ok && t.via === 'admin token') && tries.some((t) => t.ok && t.via === 'sign-in code'));
    assert(fs.existsSync(path.join(data, 'users.db')));
    await new Promise((r) => setTimeout(r, 400));
    const store = fs.readFileSync(path.join(data, 'hub.json'), 'utf8');
    assert(!store.includes('tokenHash') && !store.includes('"sessions"'), 'credentials are not kept in hub.json');
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
    assert.deepEqual(tools, ['hub_whoami', 'hub_list_agents', 'hub_send', 'hub_read', 'hub_set_avatar', 'hub_share_image', 'hub_join_channel', 'hub_leave_channel']);
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
  // wait for the hub to exit (it holds users.db open), then remove its data
  if (server.exitCode === null) await new Promise((r) => { server.once('exit', r); server.kill(); });
  fs.rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

