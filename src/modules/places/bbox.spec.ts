import { AppException } from '../../common/errors/app.exception';
import { assertBboxSpan, maxSpanForZoom, parseBbox, snapBbox } from './bbox';

describe('bbox', () => {
  it('parses and validates corners', () => {
    expect(parseBbox('16.35,48.19,16.39,48.22')).toEqual({
      minLng: 16.35,
      minLat: 48.19,
      maxLng: 16.39,
      maxLat: 48.22,
    });
    expect(() => parseBbox('16.39,48.19,16.35,48.22')).toThrow(AppException);
    expect(() => parseBbox('16,95,17,96')).toThrow(AppException);
  });

  it('limits the span by zoom', () => {
    expect(maxSpanForZoom(14)).toBeCloseTo(0.1758, 3);
    expect(maxSpanForZoom(14.9)).toBe(maxSpanForZoom(14));
    expect(maxSpanForZoom(2)).toBe(360);
    const bbox = parseBbox('16,48,16.5,48.2');
    expect(() => assertBboxSpan(bbox, maxSpanForZoom(14))).toThrow(
      expect.objectContaining({ code: 'BBOX_TOO_LARGE' }),
    );
    expect(() => assertBboxSpan(bbox, maxSpanForZoom(12))).not.toThrow();
  });

  it('snaps outwards to a quarter-tile grid', () => {
    const snapped = snapBbox(parseBbox('16.371,48.201,16.379,48.209'), 14);
    expect(snapped.minLng).toBeLessThanOrEqual(16.371);
    expect(snapped.maxLng).toBeGreaterThanOrEqual(16.379);
    expect(snapped.minLat).toBeLessThanOrEqual(48.201);
    expect(snapped.maxLat).toBeGreaterThanOrEqual(48.209);
    expect(snapBbox(parseBbox('16.3711,48.2011,16.3789,48.2089'), 14)).toEqual(
      snapped,
    );
  });
});
