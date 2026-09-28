import type { IncomingMessage } from 'node:http';
import { resolveRequestId, stripQuery } from './logger.module';

describe('stripQuery', () => {
  it('removes the query string so locations never reach the logs', () => {
    expect(stripQuery('/v1/places/nearby?lat=48.2&lng=16.37')).toBe(
      '/v1/places/nearby',
    );
    expect(stripQuery('/v1/health')).toBe('/v1/health');
    expect(stripQuery(undefined)).toBe('');
  });
});

describe('resolveRequestId', () => {
  const req = (value?: string) =>
    ({
      headers: value === undefined ? {} : { 'x-request-id': value },
    }) as IncomingMessage;

  it('keeps a well-formed incoming id', () => {
    expect(resolveRequestId(req('abc-123-def-456'))).toBe('abc-123-def-456');
  });

  it('replaces missing or suspicious ids with a UUID', () => {
    const uuid = /^[0-9a-f-]{36}$/;
    expect(resolveRequestId(req())).toMatch(uuid);
    expect(resolveRequestId(req('bad id\nforged-log-line'))).toMatch(uuid);
  });
});
