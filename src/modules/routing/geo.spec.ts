import { decodePolyline, encodePolyline, haversineMeters } from './geo';

describe('encodePolyline', () => {
  it('matches the reference example from the polyline format docs', () => {
    const points = [
      { lat: 38.5, lng: -120.2 },
      { lat: 40.7, lng: -120.95 },
      { lat: 43.252, lng: -126.453 },
    ];
    expect(encodePolyline(points)).toBe('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    expect(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@')).toEqual(points);
  });
});

describe('haversineMeters', () => {
  it('measures Vienna to Budapest at about 214 km', () => {
    const km =
      haversineMeters(
        { lat: 48.2082, lng: 16.3738 },
        { lat: 47.4979, lng: 19.0402 },
      ) / 1000;
    expect(km).toBeGreaterThan(212);
    expect(km).toBeLessThan(216);
  });
});
