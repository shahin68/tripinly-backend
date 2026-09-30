import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { presignGetUrl } from './sigv4';

describe('presignGetUrl', () => {
  it.each([
    ['https://acct.r2.cloudflarestorage.com', 'photos/abc/thumb.webp'],
    ['http://127.0.0.1:9000', "photos/a b+c/it's (1).webp"],
  ])('matches the AWS SDK presigner for %s', async (endpoint, key) => {
    const credentials = {
      accessKeyId: 'AKID',
      secretAccessKey: 'SECRET/key+1',
    };
    const signingDate = new Date('2026-09-30T08:00:00Z');
    const client = new S3Client({
      region: 'auto',
      endpoint,
      forcePathStyle: true,
      // As in StorageService.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      credentials,
    });

    const expected = await getSignedUrl(
      client,
      new GetObjectCommand({ Bucket: 'tripinly', Key: key }),
      { expiresIn: 7200, signingDate },
    );
    const actual = presignGetUrl({
      endpoint,
      region: 'auto',
      bucket: 'tripinly',
      key,
      ...credentials,
      signingDate,
      expiresInSeconds: 7200,
    });

    const sorted = (url: string) => {
      const parsed = new URL(url);
      parsed.searchParams.sort();
      return parsed.toString();
    };
    expect(sorted(actual)).toBe(sorted(expected));
  });
});
