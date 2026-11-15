import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';

export const MOTIS_STUB_PORT = 47833;
export const MOTIS_STUB_URL = `http://127.0.0.1:${MOTIS_STUB_PORT}`;

/** A real MOTIS answer (Vienna, Tuesday 2026-11-17, leaving 10:42 local time), trimmed. */
export const MOTIS_FIXTURE_TIME = '2026-11-17T09:42:00.000Z';
const FIXTURE = readFileSync(
  join(__dirname, '../fixtures/motis-plan-vienna.json'),
  'utf8',
);

export interface MotisStub {
  /** 'ok' answers the fixture moved to the requested time, 'empty' finds nothing, 'error' 500, 'hang' never answers. */
  mode: 'ok' | 'empty' | 'error' | 'hang';
  requests: URLSearchParams[];
  close: () => Promise<void>;
}

const ISO = /"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)"/g;

/** A fake transit service (MOTIS) on TRANSIT_BASE_URL (set by global-setup). */
export async function startMotisStub(): Promise<MotisStub> {
  const stub = { mode: 'ok', requests: [] } as unknown as MotisStub;
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', MOTIS_STUB_URL);
    if (url.pathname !== '/api/v5/plan') {
      res.writeHead(404).end();
      return;
    }
    stub.requests.push(url.searchParams);
    if (stub.mode === 'hang') return;
    if (stub.mode === 'error') {
      res.writeHead(500).end();
      return;
    }
    const json = (body: string) =>
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(body);
    if (stub.mode === 'empty') {
      return json(JSON.stringify({ direct: [], itineraries: [] }));
    }
    // Arriving by a time: the fixture's last arrival (10:00) lands on it.
    const anchor =
      url.searchParams.get('arriveBy') === 'true'
        ? Date.parse('2026-11-17T10:00:00Z')
        : Date.parse(MOTIS_FIXTURE_TIME);
    const delta = Date.parse(url.searchParams.get('time') ?? '') - anchor;
    json(
      FIXTURE.replace(
        ISO,
        (_, iso: string) =>
          `"${new Date(Date.parse(iso) + delta).toISOString()}"`,
      ),
    );
  });
  await new Promise<void>((resolve) =>
    server.listen(MOTIS_STUB_PORT, '127.0.0.1', resolve),
  );
  stub.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return stub;
}
