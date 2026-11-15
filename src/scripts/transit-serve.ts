import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { join } from 'node:path';
import {
  MOTIS_LOCAL_PORT,
  PackageStore,
  readTransitJobEnv,
  run,
} from '../modules/routing/transit/transit-package';

/**
 * The transit service (Railway service "transit", private network only):
 * downloads the package the builder made, starts MOTIS on it, and answers
 * on $PORT in front of it. Node listens on IPv4 and IPv6, which Railway's
 * private network needs. /api/v1/health answers 503 until MOTIS is ready,
 * so Railway switches to a new deployment only once it can route: no
 * downtime when the builder redeploys it. It never builds and needs no
 * volume.
 */
async function main(): Promise<void> {
  const env = readTransitJobEnv();
  const store = new PackageStore(env);
  const manifest = await store.manifest();
  if (!manifest) {
    throw new Error(
      'No transit package yet: run the transit-builder service once, then redeploy',
    );
  }
  const work = env.TRANSIT_WORK_DIR;
  const data = join(work, 'data');
  await rm(work, { recursive: true, force: true });
  await mkdir(data, { recursive: true });
  const archive = join(work, 'package.tar.gz');
  log(
    `Downloading ${manifest.package} (${manifest.regions.join(', ')}, built ${manifest.builtAt})`,
  );
  await store.download(manifest.package, archive);
  await run('tar', ['-xzf', archive, '-C', data]);
  await rm(archive);

  let ready = false;
  const motis = spawn('motis', ['server', '-d', data], { stdio: 'inherit' });
  motis.on('exit', (code) => {
    log(`MOTIS stopped (${code})`);
    process.exit(code ?? 1);
  });
  const stop = () => motis.kill('SIGTERM');
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  const server = createServer((req, res) => {
    if (!ready) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end('{"ready":false}');
      return;
    }
    const upstream = request(
      {
        host: '127.0.0.1',
        port: MOTIS_LOCAL_PORT,
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  // No host: IPv6 and IPv4 where the machine has both.
  server.listen(env.PORT, () => log(`Listening on ${env.PORT}`));

  const started = Date.now();
  while (!ready) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    ready = await healthy();
  }
  log(`MOTIS ready after ${Math.round((Date.now() - started) / 1000)} s`);
}

function healthy(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: MOTIS_LOCAL_PORT,
        path: '/api/v1/health',
        timeout: 2000,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => req.destroy());
    req.end();
  });
}

function log(message: string): void {
  process.stdout.write(`[transit] ${message}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `[transit] failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
