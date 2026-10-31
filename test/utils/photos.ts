import type { INestApplication } from '@nestjs/common';
import sharp from 'sharp';
import { PhotoProcessingService } from '../../src/modules/photos/photo-processing.service';
import type { Session } from './auth-helpers';
import { api } from './api';

/** A JPEG with GPS in its EXIF and orientation 6 (stored sideways): 400×200 pixels as stored. */
export function jpegWithGps(): Promise<Buffer> {
  return sharp({
    create: {
      width: 400,
      height: 200,
      channels: 3,
      background: { r: 200, g: 120, b: 40 },
    },
  })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .withExif({
      IFD0: { Make: 'TestCam' },
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '48/1 12/1 30/1',
        GPSLongitudeRef: 'E',
        GPSLongitude: '16/1 22/1 20/1',
      },
    })
    .toBuffer();
}

export function png(): Promise<Buffer> {
  return sharp({
    create: {
      width: 64,
      height: 64,
      channels: 4,
      background: { r: 0, g: 0, b: 255, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
}

export interface UploadStart {
  photo: { id: string; status: string; position: number };
  uploadUrl: string;
  uploadHeaders: Record<string, string>;
}

/** Requests an upload URL and PUTs the file there. Returns the pending photo. */
export async function upload(
  app: INestApplication,
  session: Session,
  markerId: string,
  file: Buffer,
  mimeType = 'image/jpeg',
  owner: 'markers' | 'places' = 'markers',
): Promise<UploadStart> {
  const { body } = await api(app)
    .as(session)
    .post(`/v1/${owner}/${markerId}/photos/upload-url`)
    .send({ mimeType, bytes: file.length })
    .expect(201);
  const start = body as UploadStart;
  const response = await fetch(start.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': start.uploadHeaders['Content-Type'] },
    body: new Uint8Array(file),
  });
  if (!response.ok)
    throw new Error(
      `upload failed: ${response.status} ${await response.text()}`,
    );
  return start;
}

/** Upload, complete and process (as the worker would). Returns the photo id. */
export async function readyPhoto(
  app: INestApplication,
  session: Session,
  markerId: string,
  file?: Buffer,
): Promise<string> {
  const { photo } = await upload(
    app,
    session,
    markerId,
    file ?? (await jpegWithGps()),
  );
  await api(app)
    .as(session)
    .post(`/v1/photos/${photo.id}/complete`)
    .expect(202);
  await app.get(PhotoProcessingService).process(photo.id);
  return photo.id;
}

/** A ready place photo (no trip), uploaded and processed. Returns the photo id. */
export async function readyPlacePhoto(
  app: INestApplication,
  session: Session,
  placeId: string,
): Promise<string> {
  const { photo } = await upload(
    app,
    session,
    placeId,
    await jpegWithGps(),
    'image/jpeg',
    'places',
  );
  await api(app)
    .as(session)
    .post(`/v1/photos/${photo.id}/complete`)
    .expect(202);
  await app.get(PhotoProcessingService).process(photo.id);
  return photo.id;
}

/** A profile photo uploaded, completed and processed. Returns the photo id. */
export async function readyAvatar(
  app: INestApplication,
  session: Session,
): Promise<string> {
  const file = await jpegWithGps();
  const { body } = await api(app)
    .as(session)
    .post('/v1/me/avatar/upload-url')
    .send({ mimeType: 'image/jpeg', bytes: file.length })
    .expect(201);
  const start = body as UploadStart;
  const response = await fetch(start.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': start.uploadHeaders['Content-Type'] },
    body: new Uint8Array(file),
  });
  if (!response.ok) throw new Error(`upload failed: ${response.status}`);
  await api(app)
    .as(session)
    .post(`/v1/photos/${start.photo.id}/complete`)
    .expect(202);
  await app.get(PhotoProcessingService).process(start.photo.id);
  return start.photo.id;
}
