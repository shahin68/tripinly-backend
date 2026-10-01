#!/usr/bin/env node
// Staging smoke test (deploy-railway skill): health, sign-in, onboarding,
// trip and marker with a realtime event, photo upload through the worker,
// then deletes the test account again.
//
//   DEV_AUTH_SECRET=... node scripts/smoke-test.mjs https://<api-domain>
//
// Needs DEV_AUTH_ENABLED and the same DEV_AUTH_SECRET on the staging api.
// Prints no tokens or signed URLs.
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { io } from 'socket.io-client';

const base = (process.argv[2] ?? '').replace(/\/$/, '');
const secret = process.env.DEV_AUTH_SECRET;
if (!/^https?:\/\//.test(base) || !secret) {
  console.error(
    'Usage: DEV_AUTH_SECRET=... node scripts/smoke-test.mjs https://<api-domain>',
  );
  process.exit(2);
}

let token;
let failed = false;

async function call(method, path, body, headers = {}) {
  const response = await fetch(`${base}/v1${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(
      `${method} ${path} → ${response.status} ${json?.error?.code ?? ''}`,
    );
  }
  return json;
}

async function step(name, run) {
  const started = Date.now();
  try {
    const note = await run();
    console.log(
      `✓ ${name} (${Date.now() - started} ms)${note ? `: ${note}` : ''}`,
    );
    return true;
  } catch (error) {
    failed = true;
    console.log(`✗ ${name}: ${error.message}`);
    return false;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(what, check, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}

const suffix = randomBytes(4).toString('hex');
let trip;
let markerId;
let socket;

await step('liveness', () => call('GET', '/health').then(() => undefined));
const ready = await step('readiness (database, Redis)', () =>
  call('GET', '/health/ready').then(() => undefined),
);
if (!ready) process.exit(1);

const signedIn = await step('dev sign-in', async () => {
  const tokens = await call(
    'POST',
    '/auth/dev',
    { subject: `smoke-${suffix}`, name: 'Smoke Test' },
    { 'X-Dev-Auth-Secret': secret },
  );
  token = tokens.accessToken;
});
if (!signedIn) process.exit(1);

await step('onboarding (profile and consents)', async () => {
  await call('PATCH', '/me', {
    username: `smoke_${suffix}`,
    birthDate: '1990-01-01',
  });
  const legal = await call('GET', '/legal/documents?locale=en');
  const required = legal.items.filter((doc) => doc.required);
  if (required.length === 0) {
    throw new Error(
      'no legal documents published (run the seed, see the guide)',
    );
  }
  for (const doc of required) {
    await call('POST', '/me/consents', {
      documentType: doc.documentType,
      version: doc.version,
      locale: doc.locale,
      granted: true,
    });
  }
});

await step('realtime connection', async () => {
  socket = io(`${base}/v1/realtime`, {
    auth: { token },
    transports: ['websocket'],
    reconnection: false,
  });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', (error) =>
      reject(new Error(error.data?.code ?? error.message)),
    );
  });
});

await step('trip, marker and live event', async () => {
  trip = await call('POST', '/trips', {
    title: 'Smoke test',
    visibility: 'private',
  });
  if (socket?.connected) {
    const ack = await socket
      .timeout(5000)
      .emitWithAck('trip.subscribe', { tripId: trip.id });
    if (!ack.ok) throw new Error(`subscribe refused: ${ack.error?.code}`);
  }
  const event = socket?.connected
    ? new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('no marker.created event')),
          10_000,
        );
        socket.on('marker.created', (message) => {
          clearTimeout(timer);
          resolve(message);
        });
      })
    : null;
  const marker = await call('POST', `/days/${trip.days[0].id}/markers`, {
    name: 'Stephansdom',
    location: { lat: 48.2085, lng: 16.3731 },
  });
  markerId = marker.id;
  if (event) await event;
});

await step('photo upload and processing (R2 and worker)', async () => {
  const image = await sharp({
    create: { width: 320, height: 240, channels: 3, background: '#3a7' },
  })
    .jpeg()
    .toBuffer();
  const start = await call('POST', `/markers/${markerId}/photos/upload-url`, {
    mimeType: 'image/jpeg',
    bytes: image.length,
  });
  const put = await fetch(start.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/jpeg' },
    body: image,
  });
  if (!put.ok) throw new Error(`upload to storage → ${put.status}`);
  await call('POST', `/photos/${start.photo.id}/complete`);
  await until('photo ready', async () => {
    const photos = await call('GET', `/markers/${markerId}/photos`);
    const photo = photos.find((p) => p.id === start.photo.id);
    if (photo?.status === 'failed') throw new Error('processing failed');
    return photo?.status === 'ready';
  });
});

await step('route (openrouteservice)', async () => {
  await call('POST', `/days/${trip.days[0].id}/markers`, {
    name: 'Albertina',
    location: { lat: 48.2046, lng: 16.3683 },
  });
  const route = await call(
    'GET',
    `/days/${trip.days[0].id}/route?mode=walking`,
  );
  return route.degraded
    ? 'straight lines (no ORS key, or quota used)'
    : 'real route';
});

socket?.disconnect();

await step('account deletion (cleans up)', async () => {
  const result = await call('DELETE', '/me');
  if (result.status !== 'deleting') throw new Error('unexpected response');
  const refused = await fetch(`${base}/v1/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (refused.status !== 401)
    throw new Error(`token still works (${refused.status})`);
});

console.log(failed ? '\nSmoke test FAILED' : '\nSmoke test passed');
process.exit(failed ? 1 : 0);
