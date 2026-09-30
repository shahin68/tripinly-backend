import type { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import type { Server, ServerOptions } from 'socket.io';

/**
 * Socket.IO over the Redis adapter, so rooms span every API instance and the
 * worker can publish events through @socket.io/redis-emitter.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly clients: Redis[] = [];

  constructor(
    app: INestApplicationContext,
    private readonly redisUrl: string,
  ) {
    super(app);
  }

  override createIOServer(port: number, options?: ServerOptions): Server {
    const server = super.createIOServer(port, {
      ...options,
      serveClient: false,
      // Mobile clients only; no browser origins to allow.
      cors: undefined,
    } as ServerOptions);
    // Railway's private network is IPv6-only.
    const pub = new Redis(this.redisUrl, { family: 0 });
    const sub = pub.duplicate();
    for (const client of [pub, sub]) {
      client.on('error', (error: Error) =>
        this.logger.warn(`Socket.IO Redis connection: ${error.message}`),
      );
      this.clients.push(client);
    }
    server.adapter(createAdapter(pub, sub));
    return server;
  }

  override async dispose(): Promise<void> {
    await super.dispose();
    await Promise.all(
      this.clients.map((client) =>
        client.status === 'ready'
          ? client.quit().then(
              () => undefined,
              () => client.disconnect(),
            )
          : Promise.resolve(client.disconnect()),
      ),
    );
  }
}
