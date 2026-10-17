#!/usr/bin/env node
// Generates the dashboard's images with Solframe Studio (OpenAI-compatible images API), one at a time.
// Art direction by Hades (Hermes agent), agreed in #hub-design on the hub.
//
//   SOLFRAME_URL=http://127.0.0.1:8765 SOLFRAME_KEY=... node tools/gen-images.mjs [--only name1,name2] [--force]
//
// If SOLFRAME_KEY isn't set, the key is read from Solframe's own settings (~/.solframe/agent_server.json).
// PNG masters go to art-src/ (not in the repository); tools/make-assets.py turns them into assets/*.webp.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = (process.env.SOLFRAME_URL ?? 'http://127.0.0.1:8765').replace(/\/$/, '');
const KEY = process.env.SOLFRAME_KEY ?? (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.solframe', 'agent_server.json'), 'utf8')).apiKey;
  } catch {
    return undefined;
  }
})();
if (!KEY) throw new Error('Set SOLFRAME_KEY (or run on the PC where Solframe Studio is installed)');

const STYLE = 'technical blueprint etching, fine ink cross-hatching on deep slate background, single cyan accent line, minimalist, professional, centered composition, no text, no letters';
const NEGATIVE = 'photorealistic, photograph, rainbow colors, gradients, watermark, signature, text, letters, words, blurry, low quality, extra limbs, chibi, nsfw, clutter';
const FLUX = { pipeline: 'flux', unet_model: 'flux-2-klein-4b-fp8-official.safetensors', clip_model: 'qwen3-4b-heretic_fp8_e4m3fn.safetensors', vae_model: 'flux2-vae.safetensors', sampling_method: 'euler' };

const IMAGES = [
  { name: 'logo-mark', w: 1024, h: 1024, steps: 30, cfg: 3.8, prompt: 'a logo mark: an interlocking triangular network of three round nodes joined by lines, one node glowing cyan, simple bold geometric emblem, icon design' },
  { name: 'login-hero', w: 1536, h: 1024, steps: 35, cfg: 3.6, prompt: 'a quiet control room at night, three silhouetted figures at consoles, each connected by a thread of light to one central hub, a starfield of tiny status lights, wide cinematic view' },
  { name: 'empty-conversations', w: 1024, h: 1024, steps: 32, cfg: 3.6, prompt: 'two empty chairs facing each other, a slack thread of light dipping between them, quiet waiting atmosphere' },
  { name: 'empty-agents', w: 1024, h: 1024, steps: 32, cfg: 3.6, prompt: 'a single empty pedestal under fine etched rays of light, the faint outline of a figure waiting to be drawn' },
  { name: 'empty-channels', w: 1024, h: 1024, steps: 32, cfg: 3.6, prompt: 'a still lake drawn in fine horizontal hatching, one ripple ring expanding from a single drop of water' },
  { name: 'avatar-http', w: 512, h: 512, steps: 30, cfg: 3.6, prompt: 'a figure whose head is a bell-shaped speech bubble, radiating fine signal arcs, portrait, character emblem' },
  { name: 'avatar-mcp', w: 512, h: 512, steps: 30, cfg: 3.6, prompt: 'a figure whose head is a navigation compass, small gear fragments orbiting around it, portrait, character emblem' },
  { name: 'avatar-script', w: 512, h: 512, steps: 30, cfg: 3.6, prompt: 'a coiled serpent drawn as one continuous etched line forming a loop, emblem' },
];

const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : null;
const force = args.includes('--force');
const outDir = path.join(root, 'art-src');
fs.mkdirSync(outDir, { recursive: true });
const headers = { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' };

for (const [i, img] of IMAGES.entries()) {
  if (only && !only.includes(img.name)) continue;
  const file = path.join(outDir, `${img.name}.png`);
  if (!force && fs.existsSync(file)) {
    console.log(`- ${img.name} exists`);
    continue;
  }
  const t0 = Date.now();
  // One request at a time: concurrent generations exhaust a 12 GB GPU
  const res = await fetch(`${BASE}/v1/images/generations`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...FLUX, prompt: `${img.prompt}, ${STYLE}`, negative_prompt: NEGATIVE, width: img.w, height: img.h, size: `${img.w}x${img.h}`, n: 1, steps: img.steps, cfg_scale: img.cfg, seed: 4200 + i, response_format: 'b64_json' }),
    signal: AbortSignal.timeout(15 * 60 * 1000),
  });
  if (!res.ok) {
    console.log(`✗ ${img.name}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    continue;
  }
  const { data } = await res.json();
  const item = data[0];
  const bytes = item.b64_json ? Buffer.from(item.b64_json, 'base64') : Buffer.from(await (await fetch(new URL(item.url, BASE), { headers })).arrayBuffer());
  fs.writeFileSync(file, bytes);
  console.log(`✓ ${img.name} ${img.w}x${img.h} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
}
console.log('done');
