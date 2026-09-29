import { representativePoint } from './geometry';

describe('representativePoint', () => {
  it('uses a node as is', () => {
    expect(
      representativePoint({ type: 'Point', coordinates: [16.37, 48.2] }),
    ).toEqual({ lat: 48.2, lng: 16.37 });
  });

  it('takes the middle vertex of a line', () => {
    expect(
      representativePoint({
        type: 'LineString',
        coordinates: [
          [0, 0],
          [1, 1],
          [2, 2],
        ],
      }),
    ).toEqual({ lat: 1, lng: 1 });
  });

  it('uses the centroid of a convex area', () => {
    const point = representativePoint({
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [2, 0],
          [2, 2],
          [0, 2],
          [0, 0],
        ],
      ],
    });
    expect(point?.lat).toBeCloseTo(1);
    expect(point?.lng).toBeCloseTo(1);
  });

  it('keeps the point inside a concave area', () => {
    // A thin "U": the centroid falls in the gap between the arms.
    const point = representativePoint({
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [9, 10],
          [9, 1],
          [1, 1],
          [1, 10],
          [0, 10],
          [0, 0],
        ],
      ],
    })!;
    const inLeftArm = point.lng > 0 && point.lng < 1;
    const inRightArm = point.lng > 9 && point.lng < 10;
    const inBase = point.lat > 0 && point.lat < 1;
    expect(inLeftArm || inRightArm || inBase).toBe(true);
  });

  it('avoids holes', () => {
    const point = representativePoint({
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
          [0, 0],
        ],
        [
          [2, 2],
          [8, 2],
          [8, 8],
          [2, 8],
          [2, 2],
        ],
      ],
    })!;
    const inHole =
      point.lng > 2 && point.lng < 8 && point.lat > 2 && point.lat < 8;
    expect(inHole).toBe(false);
  });

  it('picks the largest polygon of a multipolygon', () => {
    const point = representativePoint({
      type: 'MultiPolygon',
      coordinates: [
        [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
            [0, 0],
          ],
        ],
        [
          [
            [10, 10],
            [20, 10],
            [20, 20],
            [10, 20],
            [10, 10],
          ],
        ],
      ],
    });
    expect(point?.lng).toBeCloseTo(15);
    expect(point?.lat).toBeCloseTo(15);
  });

  it('rejects unusable geometry', () => {
    expect(
      representativePoint({ type: 'Point', coordinates: [200, 95] }),
    ).toBeNull();
    expect(
      representativePoint({ type: 'GeometryCollection', coordinates: [] }),
    ).toBeNull();
  });
});
