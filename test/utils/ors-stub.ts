import { createServer, type Server } from 'node:http';

export const ORS_STUB_PORT = 47832;
export const ORS_STUB_URL = `http://127.0.0.1:${ORS_STUB_PORT}`;
export const ORS_STUB_KEY = 'test-ors-key';

export interface OrsRequest {
  path: string;
  authorization: string | undefined;
  body: { coordinates?: number[][]; locations?: number[][] };
}

export interface OrsStub {
  /** 'ok' answers, 'error' returns 500, 'rate_limited' 429, 'hang' never answers. */
  mode: 'ok' | 'error' | 'rate_limited' | 'hang';
  /** Durations the next matrix calls return; computed from distance when null. */
  matrix: (number | null)[][] | null;
  requests: OrsRequest[];
  close: () => Promise<void>;
}

const metres = ([lng1, lat1]: number[], [lng2, lat2]: number[]) => {
  const rad = Math.PI / 180;
  const x = (lng2 - lng1) * rad * Math.cos(((lat1 + lat2) / 2) * rad);
  const y = (lat2 - lat1) * rad;
  return Math.hypot(x, y) * 6_371_000;
};

/**
 * A fake openrouteservice on ORS_BASE_URL (set by global-setup). Directions
 * return a line through the waypoints with a midpoint on every leg, 1.2 ×
 * the straight distance, at 1.25 m/s.
 */
export async function startOrsStub(): Promise<OrsStub> {
  const stub = { mode: 'ok', matrix: null, requests: [] } as unknown as OrsStub;
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as OrsRequest['body'];
      stub.requests.push({
        path: req.url ?? '',
        authorization: req.headers.authorization,
        body,
      });
      if (stub.mode === 'hang') return;
      if (stub.mode !== 'ok') {
        res.writeHead(stub.mode === 'error' ? 500 : 429).end();
        return;
      }
      const json = (value: unknown) =>
        res
          .writeHead(200, { 'Content-Type': 'application/json' })
          .end(JSON.stringify(value));

      if (req.url?.startsWith('/v2/directions/')) {
        const points = body.coordinates ?? [];
        const line: number[][] = [points[0]];
        const segments = points.slice(1).map((to, i) => {
          const from = points[i];
          line.push([(from[0] + to[0]) / 2, (from[1] + to[1]) / 2], to);
          const distance = metres(from, to) * 1.2;
          return { distance, duration: distance / 1.25 };
        });
        const distance = segments.reduce((sum, s) => sum + s.distance, 0);
        return json({
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              geometry: { type: 'LineString', coordinates: line },
              properties: {
                summary: { distance, duration: distance / 1.25 },
                segments,
              },
            },
          ],
        });
      }
      if (req.url?.startsWith('/v2/matrix/')) {
        const locations = body.locations ?? [];
        return json({
          durations:
            stub.matrix ??
            locations.map((a) => locations.map((b) => metres(a, b) / 1.25)),
        });
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(ORS_STUB_PORT, '127.0.0.1', resolve),
  );
  stub.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return stub;
}
