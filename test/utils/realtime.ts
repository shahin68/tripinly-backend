import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import { io, type Socket } from 'socket.io-client';
import type { Session } from './auth-helpers';

export interface RealtimeEvent<T = Record<string, unknown>> {
  event: string;
  tripId: string | null;
  actorId: string | null;
  at: string;
  data: T;
}

/** Starts listening on a random port (once) and returns the realtime URL. */
export async function realtimeUrl(app: INestApplication): Promise<string> {
  const server = app.getHttpServer() as import('node:http').Server;
  if (!server.listening) await app.listen(0, '127.0.0.1');
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/v1/realtime`;
}

/** A socket that records every event it receives. */
export class TestSocket {
  readonly received: RealtimeEvent[] = [];

  constructor(readonly socket: Socket) {
    socket.onAny((event: string, payload: RealtimeEvent) => {
      this.received.push({ ...payload, event: payload?.event ?? event });
    });
  }

  events(name: string): RealtimeEvent[] {
    return this.received.filter((event) => event.event === name);
  }

  /** Resolves with the first matching event, waiting up to `timeoutMs`. */
  async waitFor<T = Record<string, unknown>>(
    name: string,
    match: (event: RealtimeEvent<T>) => boolean = () => true,
    timeoutMs = 3000,
  ): Promise<RealtimeEvent<T>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = (this.events(name) as RealtimeEvent<T>[]).find(match);
      if (found) return found;
      if (Date.now() > deadline) {
        throw new Error(
          `no ${name} within ${timeoutMs} ms; got ${this.received.map((e) => e.event).join(', ') || 'nothing'}`,
        );
      }
      await sleep(25);
    }
  }

  emit<T>(event: string, body: unknown): Promise<T> {
    return this.socket.timeout(3000).emitWithAck(event, body) as Promise<T>;
  }

  subscribe(tripId: string): Promise<{
    ok: boolean;
    tripId?: string;
    error?: { code: string };
  }> {
    return this.emit('trip.subscribe', { tripId });
  }

  close(): void {
    this.socket.disconnect();
  }
}

export function connectRaw(url: string, token?: string): Socket {
  return io(url, {
    auth: token === undefined ? {} : { token },
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
  });
}

/** Connects as a user; rejects with the connect_error code. */
export function connect(url: string, session: Session): Promise<TestSocket> {
  return connectWithToken(url, session.accessToken);
}

export function connectWithToken(
  url: string,
  token?: string,
): Promise<TestSocket> {
  const socket = connectRaw(url, token);
  const recorder = new TestSocket(socket);
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(recorder));
    socket.once(
      'connect_error',
      (error: Error & { data?: { code?: string } }) => {
        socket.disconnect();
        reject(new Error(error.data?.code ?? error.message));
      },
    );
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls until `check` returns something truthy, or throws after the timeout. */
export async function eventually<T>(
  check: () => Promise<T | undefined | false | 0> | T | undefined | false | 0,
  timeoutMs = 5000,
  what = 'condition',
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}
