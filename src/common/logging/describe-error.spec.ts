import { describeError } from './describe-error';

describe('describeError', () => {
  it("adds fetch's hidden reason with its code", () => {
    const error = new TypeError('fetch failed', {
      cause: Object.assign(new Error('getaddrinfo failed'), {
        code: 'ENOTFOUND',
      }),
    });
    expect(describeError(error)).toBe(
      'fetch failed: ENOTFOUND getaddrinfo failed',
    );
  });

  it('names a failed command, how it ended and its stderr', () => {
    const error = Object.assign(
      new Error('Command failed: osmium extract -o out.pbf'),
      {
        cmd: 'osmium extract -o out.pbf',
        code: 1,
        signal: null,
        stderr: 'bad input\n',
      },
    );
    expect(describeError(error)).toBe(
      'osmium extract failed (exit code 1): bad input',
    );
  });

  it('keeps a plain message', () => {
    expect(describeError(new Error('answered 503'))).toBe('answered 503');
    expect(describeError('odd')).toBe('odd');
  });
});
