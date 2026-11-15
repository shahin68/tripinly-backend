import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { z } from 'zod';
import { TRANSIT_REGIONS } from './transit-regions';

/**
 * The built MOTIS data travels from the transit builder to the transit
 * service through storage (R2), so the live service never builds and needs
 * no volume. Both run from docker/transit.Dockerfile, without a database.
 */
export const MANIFEST_KEY = 'transit/current.json';
export const PACKAGE_PREFIX = 'transit/packages/';
/** MOTIS listens here inside the transit service; Node answers on $PORT in front of it. */
export const MOTIS_LOCAL_PORT = 8081;

export interface TransitManifest {
  /** The package to serve, e.g. transit/packages/2026-11-15T13-05-00Z.tar.gz. */
  package: string;
  builtAt: string;
  regions: string[];
  /** Per feed (region:feed): how the builder recognises an unchanged download. */
  feeds: Record<
    string,
    { sha256: string; etag?: string; lastModified?: string }
  >;
  /** When the streets were last downloaded; refreshed every 30 days. */
  osmAt: string;
}

const optional = z
  .string()
  .trim()
  .transform((value) => (value === '' ? undefined : value))
  .optional();

/** The variables the transit service and builder read (no database). */
export const transitJobEnvSchema = z.object({
  TRANSIT_REGIONS: z
    .string()
    .default('vienna')
    .transform((value) =>
      value
        .split(',')
        .map((region) => region.trim())
        .filter(Boolean),
    )
    .pipe(
      z
        .array(z.string().refine((id) => Object.hasOwn(TRANSIT_REGIONS, id)))
        .min(1),
    ),
  R2_ACCOUNT_ID: optional,
  R2_ENDPOINT: optional,
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
  R2_BUCKET: z.string().min(1),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  GEOFABRIK_BASE_URL: z.string().default('https://download.geofabrik.de'),
  /** Scratch space; the builder needs about 2 GB, the service about 300 MB per city. */
  TRANSIT_WORK_DIR: z.string().default('/tmp/transit'),
  /** A Railway project token for this environment: the builder redeploys the transit service with it. */
  RAILWAY_API_TOKEN: optional,
  /** Set by Railway on every service. */
  RAILWAY_ENVIRONMENT_ID: optional,
  /** Reference ${{transit.RAILWAY_SERVICE_ID}} on the builder. */
  TRANSIT_SERVICE_ID: optional,
});
export type TransitJobEnv = z.infer<typeof transitJobEnvSchema>;

export function readTransitJobEnv(): TransitJobEnv {
  const result = transitJobEnvSchema.safeParse(
    Object.fromEntries(
      Object.entries(process.env).filter(([, value]) => value?.trim()),
    ),
  );
  if (!result.success) {
    // Names only, never values.
    throw new Error(
      `Invalid environment: ${result.error.issues.map((issue) => issue.path.join('.')).join(', ')}`,
    );
  }
  if (!result.data.R2_ENDPOINT && !result.data.R2_ACCOUNT_ID) {
    throw new Error('Invalid environment: set R2_ACCOUNT_ID or R2_ENDPOINT');
  }
  return result.data;
}

export class PackageStore {
  private readonly client: S3Client;

  constructor(private readonly env: TransitJobEnv) {
    this.client = new S3Client({
      region: 'auto',
      endpoint:
        env.R2_ENDPOINT ??
        `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      forcePathStyle: true,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      },
    });
  }

  async manifest(): Promise<TransitManifest | null> {
    try {
      const object = await this.client.send(
        new GetObjectCommand({ Bucket: this.env.R2_BUCKET, Key: MANIFEST_KEY }),
      );
      return JSON.parse(
        (await object.Body?.transformToString()) ?? 'null',
      ) as TransitManifest | null;
    } catch (error) {
      if (error instanceof NoSuchKey) return null;
      throw error;
    }
  }

  async saveManifest(manifest: TransitManifest): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.env.R2_BUCKET,
        Key: MANIFEST_KEY,
        Body: JSON.stringify(manifest, null, 2),
        ContentType: 'application/json',
      }),
    );
  }

  async upload(key: string, file: string): Promise<void> {
    const { size } = await stat(file);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.env.R2_BUCKET,
        Key: key,
        Body: createReadStream(file),
        ContentLength: size,
        ContentType: 'application/gzip',
      }),
    );
  }

  async download(key: string, file: string): Promise<void> {
    const object = await this.client.send(
      new GetObjectCommand({ Bucket: this.env.R2_BUCKET, Key: key }),
    );
    if (!object.Body) throw new Error(`Empty object ${key}`);
    await pipeline(
      object.Body as NodeJS.ReadableStream,
      createWriteStream(file),
    );
  }

  /** Deletes every package but the ones kept (the live one and the one before, for a rollback). */
  async prune(keep: string[]): Promise<void> {
    const listed = await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.env.R2_BUCKET,
        Prefix: PACKAGE_PREFIX,
      }),
    );
    for (const object of listed.Contents ?? []) {
      if (object.Key && !keep.includes(object.Key)) {
        await this.client.send(
          new DeleteObjectCommand({
            Bucket: this.env.R2_BUCKET,
            Key: object.Key,
          }),
        );
      }
    }
  }
}

/** Runs a command, its output passed through; rejects on a non-zero exit. */
export function run(
  command: string,
  args: string[],
  cwd?: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} ${args[0] ?? ''} exited with ${code}`)),
    );
  });
}
