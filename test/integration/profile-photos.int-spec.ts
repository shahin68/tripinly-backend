import type { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { StorageService } from '../../src/common/storage/storage.service';
import { PhotoProcessingModule } from '../../src/modules/photos/photo-processing.module';
import { PhotoProcessingService } from '../../src/modules/photos/photo-processing.service';
import { photoKeys } from '../../src/modules/photos/photo-keys';
import {
  devSignIn,
  onboardedUser,
  publishLegalDocuments,
  resetState,
  type Session,
} from '../utils/auth-helpers';
import { api, type TripBody } from '../utils/api';
import { createTestApp } from '../utils/create-test-app';
import { jpegWithGps, readyAvatar } from '../utils/photos';

interface Summary {
  id: string;
  username: string;
  avatarPhotoId: string | null;
  avatarThumbUrl: string | null;
}

describe('Profile photos (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let as: ReturnType<typeof api>['as'];
  let jonas: Session;
  let mia: Session;

  beforeAll(async () => {
    app = await createTestApp({ imports: [PhotoProcessingModule] });
    prisma = app.get(PrismaService);
    as = api(app).as;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetState(app);
    await publishLegalDocuments(app);
    jonas = await onboardedUser(app, 'jonas');
    mia = await onboardedUser(app, 'mia');
  });

  const me = async (session: Session) =>
    (await as(session).get('/v1/me').expect(200)).body as Summary;

  const fileExists = (photoId: string) =>
    app
      .get(StorageService)
      .head(photoKeys(photoId).thumb)
      .then((head) => head !== null);

  it('is optional: no photo means a letter avatar', async () => {
    expect(await me(jonas)).toMatchObject({
      avatarPhotoId: null,
      avatarThumbUrl: null,
    });
  });

  it('becomes the avatar on GET /me and on every user summary', async () => {
    const photoId = await readyAvatar(app, jonas);
    const mine = await me(jonas);
    expect(mine.avatarPhotoId).toBe(photoId);
    expect(mine.avatarThumbUrl).toContain(photoKeys(photoId).thumb);

    const trip = (
      await as(jonas)
        .post('/v1/trips')
        .send({ title: 'Vienna', visibility: 'public' })
        .expect(201)
    ).body as TripBody & { owner: Summary };
    expect(trip.owner.avatarPhotoId).toBe(photoId);

    const profile = (await as(mia).get('/v1/users/jonas').expect(200)).body as {
      user: Summary;
    };
    expect(profile.user).toMatchObject({
      avatarPhotoId: photoId,
      avatarThumbUrl: expect.stringContaining(photoKeys(photoId).thumb),
    });
  });

  it('works during onboarding, before a username exists', async () => {
    const newcomer = await devSignIn(app, 'newcomer', 'Newcomer');
    const photoId = await readyAvatar(app, newcomer);
    expect((await me(newcomer)).avatarPhotoId).toBe(photoId);
  });

  it('replaces the previous photo and deletes it', async () => {
    const first = await readyAvatar(app, jonas);
    const second = await readyAvatar(app, jonas);
    expect((await me(jonas)).avatarPhotoId).toBe(second);
    expect(await prisma.photo.findUnique({ where: { id: first } })).toBeNull();
    expect(await fileExists(first)).toBe(false);
  });

  it('keeps the newer photo when an older upload finishes later', async () => {
    const file = await jpegWithGps();
    const start = async () => {
      const { body } = await as(jonas)
        .post('/v1/me/avatar/upload-url')
        .send({ mimeType: 'image/jpeg', bytes: file.length })
        .expect(201);
      const { photo, uploadUrl } = body as {
        photo: { id: string };
        uploadUrl: string;
      };
      await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'image/jpeg' },
        body: new Uint8Array(file),
      });
      await as(jonas).post(`/v1/photos/${photo.id}/complete`).expect(202);
      return photo.id;
    };
    const older = await start();
    const newer = await start();
    const processing = app.get(PhotoProcessingService);
    expect(await processing.process(newer)).toBe('ready');
    expect(await processing.process(older)).toBe('deleted');
    expect((await me(jonas)).avatarPhotoId).toBe(newer);
    expect(await prisma.photo.findUnique({ where: { id: older } })).toBeNull();
  });

  it('removes the photo: back to the letter avatar', async () => {
    const photoId = await readyAvatar(app, jonas);
    await as(jonas).delete('/v1/me/avatar').expect(204);
    expect(await me(jonas)).toMatchObject({ avatarPhotoId: null });
    expect(
      await prisma.photo.findUnique({ where: { id: photoId } }),
    ).toBeNull();
    // Harmless without one.
    await as(jonas).delete('/v1/me/avatar').expect(204);
  });

  it('refuses other file types and someone else completing the upload', async () => {
    const { body } = await as(jonas)
      .post('/v1/me/avatar/upload-url')
      .send({ mimeType: 'image/gif', bytes: 1000 })
      .expect(415);
    expect(body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    const started = (
      await as(jonas)
        .post('/v1/me/avatar/upload-url')
        .send({ mimeType: 'image/jpeg', bytes: 1000 })
        .expect(201)
    ).body as { photo: { id: string } };
    await as(mia).post(`/v1/photos/${started.photo.id}/complete`).expect(403);
    await api(app).anonymous.post('/v1/me/avatar/upload-url').expect(401);
  });

  it("can't be liked, can be reported, and hiding it brings back the letter", async () => {
    const photoId = await readyAvatar(app, jonas);
    await as(mia).put(`/v1/likes/photo/${photoId}`).expect(404);
    const reportId = (
      await as(mia)
        .post('/v1/reports')
        .send({ targetType: 'photo', targetId: photoId, reason: 'nudity' })
        .expect(201)
    ).body.id as string;

    const admin = await onboardedUser(app, 'lena');
    await prisma.user.update({
      where: { id: admin.userId },
      data: { role: 'admin' },
    });
    await as(admin)
      .patch(`/v1/admin/reports/${reportId}`)
      .send({ action: 'hide_content' })
      .expect(200);
    expect(await me(jonas)).toMatchObject({ avatarPhotoId: null });
  });

  it('deleting the photo itself also clears the avatar', async () => {
    const photoId = await readyAvatar(app, jonas);
    await as(jonas)
      .delete('/v1/photos/' + photoId)
      .expect(204);
    expect(await me(jonas)).toMatchObject({ avatarPhotoId: null });
  });
});
