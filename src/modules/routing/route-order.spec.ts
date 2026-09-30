import { optimizeOrder, pathCost } from './route-order';

/** Stops on a line at these positions; cost is the distance between them. */
function lineCosts(positions: number[]): number[][] {
  return positions.map((a) => positions.map((b) => Math.abs(a - b)));
}

describe('optimizeOrder', () => {
  it('keeps the first stop and visits a line in order', () => {
    const cost = lineCosts([0, 3, 1, 4, 2]);
    expect(optimizeOrder(cost)).toEqual([0, 2, 4, 1, 3]);
  });

  it('never does worse than the given order', () => {
    const points = Array.from({ length: 25 }, (_, i) => [
      Math.sin(i * 7.3) * 10,
      Math.cos(i * 3.1) * 10,
    ]);
    const cost = points.map(([ax, ay]) =>
      points.map(([bx, by]) => Math.hypot(ax - bx, ay - by)),
    );
    const order = optimizeOrder(cost);
    expect(order[0]).toBe(0);
    expect([...order].sort((a, b) => a - b)).toEqual([...Array(25).keys()]);
    const identity = [...Array(25).keys()];
    expect(pathCost(order, cost)).toBeLessThanOrEqual(pathCost(identity, cost));
  });

  it('respects asymmetric costs', () => {
    // 0→1 is cheap but 1→2 is expensive; 0→2→1 is better overall.
    const cost = [
      [0, 1, 2],
      [9, 0, 50],
      [9, 1, 0],
    ];
    expect(optimizeOrder(cost)).toEqual([0, 2, 1]);
  });

  it('handles tiny inputs', () => {
    expect(optimizeOrder([])).toEqual([]);
    expect(optimizeOrder([[0]])).toEqual([0]);
    expect(
      optimizeOrder([
        [0, 1],
        [1, 0],
      ]),
    ).toEqual([0, 1]);
  });
});
