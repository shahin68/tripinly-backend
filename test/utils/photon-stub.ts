import { createServer, type Server } from 'node:http';

export const PHOTON_STUB_PORT = 47831;
export const PHOTON_STUB_URL = `http://127.0.0.1:${PHOTON_STUB_PORT}`;

export interface PhotonStub {
  /** GeoJSON features the next searches return. */
  features: unknown[];
  /** 'ok' answers, 'error' returns 500, 'hang' never answers (client timeout). */
  mode: 'ok' | 'error' | 'hang';
  /** Query strings received, for asserting what we send. */
  requests: URLSearchParams[];
  close: () => Promise<void>;
}

/** A fake Photon on PHOTON_BASE_URL (set by global-setup). */
export async function startPhotonStub(): Promise<PhotonStub> {
  const stub = {
    features: [],
    mode: 'ok',
    requests: [],
  } as unknown as PhotonStub;
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', PHOTON_STUB_URL);
    stub.requests.push(url.searchParams);
    if (stub.mode === 'hang') return;
    if (stub.mode === 'error' || url.pathname !== '/api') {
      res.writeHead(500).end();
      return;
    }
    res
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(
        JSON.stringify({ type: 'FeatureCollection', features: stub.features }),
      );
  });
  await new Promise<void>((resolve) =>
    server.listen(PHOTON_STUB_PORT, '127.0.0.1', resolve),
  );
  stub.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return stub;
}
