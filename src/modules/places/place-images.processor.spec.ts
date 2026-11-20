import type { Job, Queue } from 'bullmq';
import type { BrandLogosService } from './brand-logos.service';
import { PlaceImagesProcessor } from './place-images.processor';
import { PlaceImageJobs } from './place-images.queue';
import type { PlaceImagesService } from './place-images.service';

function processor(logos: () => Promise<unknown>) {
  const images = {
    sync: jest.fn().mockResolvedValue({ places: 0, more: false }),
  };
  const queue = { add: jest.fn() };
  const brandLogos = { sync: jest.fn(logos) };
  const subject = new PlaceImagesProcessor(
    images as unknown as PlaceImagesService,
    brandLogos as unknown as BrandLogosService,
    queue as unknown as Queue,
  );
  return { subject, images, queue, brandLogos };
}

const job = { name: PlaceImageJobs.SYNC } as Job;

describe('PlaceImagesProcessor', () => {
  it('syncs the brand logos before the place photos', async () => {
    const order: string[] = [];
    const { subject, images, brandLogos } = processor(() => {
      order.push('logos');
      return Promise.resolve({ brands: 1, logos: 1, more: false });
    });
    images.sync.mockImplementation(() => {
      order.push('photos');
      return Promise.resolve({ places: 0, more: false });
    });
    await subject.process(job);
    expect(order).toEqual(['logos', 'photos']);
    expect(brandLogos.sync).toHaveBeenCalledTimes(1);
  });

  it('still syncs the photos when the logos fail', async () => {
    const { subject, images, queue } = processor(() =>
      Promise.reject(new Error('maxlag')),
    );
    await expect(subject.process(job)).resolves.toMatchObject({
      brandLogos: { brands: 0, logos: 0 },
    });
    expect(images.sync).toHaveBeenCalledTimes(1);
    expect(queue.add).not.toHaveBeenCalled();
  });
});
