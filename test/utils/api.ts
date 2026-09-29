import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { Session } from './auth-helpers';

type Method = 'get' | 'post' | 'patch' | 'put' | 'delete';

/** Supertest bound to a signed-in user: `as(alice).post('/v1/trips').send(...)`. */
export function api(app: INestApplication) {
  const call = (session: Session | undefined, method: Method, path: string) => {
    const req = request(app.getHttpServer())[method](path);
    return session ? req.auth(session.accessToken, { type: 'bearer' }) : req;
  };
  return {
    as: (session: Session) => ({
      get: (path: string) => call(session, 'get', path),
      post: (path: string) => call(session, 'post', path),
      patch: (path: string) => call(session, 'patch', path),
      put: (path: string) => call(session, 'put', path),
      delete: (path: string) => call(session, 'delete', path),
    }),
    anonymous: {
      get: (path: string) => call(undefined, 'get', path),
      post: (path: string) => call(undefined, 'post', path),
    },
  };
}

export interface TripBody {
  id: string;
  days: {
    id: string;
    position: number;
    date: string | null;
    markers: { id: string; position: number }[];
  }[];
  [key: string]: unknown;
}
