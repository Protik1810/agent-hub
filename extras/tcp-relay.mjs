#!/usr/bin/env node
// Makes a service that only listens on 127.0.0.1 (a local AI server, an image generator...) reachable by agents on
// your local network, by relaying TCP connections unchanged. The service's own authentication still applies.
// No dependencies; Node.js 18+.
//
//   RELAY_HOST=192.168.1.10 RELAY_PORT=8765 TARGET=127.0.0.1:8765 RELAY_ALLOW=192.168.1.20 node extras/tcp-relay.mjs
//
// RELAY_HOST    this machine's LAN address to listen on (required; not 127.0.0.1, which the service already uses)
// RELAY_PORT    port to listen on (required)
// TARGET        host:port of the local service (required)
// RELAY_ALLOW   optional comma-separated client IPs allowed to connect; otherwise any private-network address
import net from 'node:net';

const HOST = process.env.RELAY_HOST;
const PORT = Number(process.env.RELAY_PORT);
const TARGET = process.env.TARGET ?? '';
if (!HOST || !PORT || !/^[^:]+:\d+$/.test(TARGET)) {
  console.error('Set RELAY_HOST, RELAY_PORT and TARGET (host:port). See the comments at the top of this file.');
  process.exit(2);
}
const [targetHost, targetPort] = TARGET.split(':');
const allow = (process.env.RELAY_ALLOW ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const PRIVATE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/; // LAN and Tailscale ranges

const clientIp = (socket) => (socket.remoteAddress ?? '').replace(/^::ffff:/, '');
const stamp = () => new Date().toISOString();

const server = net.createServer((client) => {
  const ip = clientIp(client);
  if (!PRIVATE.test(ip) || (allow.length && !allow.includes(ip))) {
    console.log(`${stamp()} refused ${ip}`);
    return client.destroy();
  }
  const upstream = net.connect(Number(targetPort), targetHost);
  console.log(`${stamp()} ${ip} connected`);
  client.pipe(upstream).pipe(client);
  const close = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on('error', close);
  upstream.on('error', (e) => {
    console.log(`${stamp()} target unreachable (${e.code ?? e.message})`);
    close();
  });
  client.setTimeout(15 * 60 * 1000, close); // long-running requests (image generation) can take minutes
});

server.on('error', (e) => {
  console.error(`relay: ${e.message}`);
  process.exit(1);
});
server.listen(PORT, HOST, () => console.log(`relay: ${HOST}:${PORT} -> ${TARGET}${allow.length ? ` (allowed: ${allow.join(', ')})` : ' (private-network clients only)'}`));
