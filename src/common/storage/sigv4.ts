import { createHash, createHmac } from 'node:crypto';

export interface PresignGetInput {
  endpoint: string;
  region: string;
  bucket: string;
  key: string;
  accessKeyId: string;
  secretAccessKey: string;
  signingDate: Date;
  expiresInSeconds: number;
}

/** RFC 3986 encoding as SigV4 wants it; `/` kept when encoding a path. */
function encode(value: string, keepSlash = false): string {
  return encodeURIComponent(value)
    .replace(
      /[!'()*]/g,
      (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
    )
    .replace(keepSlash ? /%2F/g : /$^/, '/');
}

const hmac = (key: Buffer | string, data: string) =>
  createHmac('sha256', key).update(data).digest();

/**
 * A pre-signed GET URL (AWS Signature V4, path style), computed synchronously
 * so response mappers can sign without awaiting. Produces the same URL as
 * `@aws-sdk/s3-request-presigner` for GetObject with StorageService's client
 * settings (checked in the unit test).
 */
export function presignGetUrl(input: PresignGetInput): string {
  const endpoint = new URL(input.endpoint);
  const amzDate = input.signingDate
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${input.region}/s3/aws4_request`;
  const path = `${endpoint.pathname.replace(/\/$/, '')}/${encode(input.bucket)}/${encode(input.key, true)}`;

  const query: [string, string][] = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Content-Sha256', 'UNSIGNED-PAYLOAD'],
    ['X-Amz-Credential', `${input.accessKeyId}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(input.expiresInSeconds)],
    ['X-Amz-SignedHeaders', 'host'],
    ['x-id', 'GetObject'],
  ];
  const canonicalQuery = query
    .map(([name, value]) => `${encode(name)}=${encode(value)}`)
    .sort()
    .join('&');
  const canonicalRequest = [
    'GET',
    path,
    canonicalQuery,
    `host:${endpoint.host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, day), input.region), 's3'),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey)
    .update(stringToSign)
    .digest('hex');
  return `${endpoint.origin}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
