import sharp from 'sharp';
import { sniffImageType } from './image-type';

describe('sniffImageType', () => {
  const image = () =>
    sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } });

  it('recognises JPEG, PNG and WebP by their bytes', async () => {
    expect(sniffImageType(await image().jpeg().toBuffer())).toBe('image/jpeg');
    expect(sniffImageType(await image().png().toBuffer())).toBe('image/png');
    expect(sniffImageType(await image().webp().toBuffer())).toBe('image/webp');
  });

  it('rejects anything else', async () => {
    expect(sniffImageType(await image().gif().toBuffer())).toBeNull();
    expect(
      sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')),
    ).toBeNull();
    expect(sniffImageType(Buffer.alloc(0))).toBeNull();
  });
});
