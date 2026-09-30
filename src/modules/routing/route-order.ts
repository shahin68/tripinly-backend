/** cost[i][j]: cost of going from stop i to stop j. */
export type CostMatrix = number[][];

/** Total cost of visiting the stops in `order`. */
export function pathCost(order: number[], cost: CostMatrix): number {
  let total = 0;
  for (let i = 1; i < order.length; i++) total += cost[order[i - 1]][order[i]];
  return total;
}

/**
 * Best order of stops starting at stop 0 (fixed), ending anywhere: nearest
 * neighbour, then 2-opt (reversing any stretch after the start) until no
 * reversal helps. Works for asymmetric costs (travel times); fine for the
 * ≤ 25 stops a day is optimized with.
 */
export function optimizeOrder(cost: CostMatrix): number[] {
  const n = cost.length;
  if (n <= 2) return [...Array(n).keys()];

  const order = [0];
  const left = new Set([...Array(n).keys()].slice(1));
  while (left.size > 0) {
    const from = order[order.length - 1];
    let best = -1;
    for (const candidate of left) {
      if (best === -1 || cost[from][candidate] < cost[from][best]) {
        best = candidate;
      }
    }
    order.push(best);
    left.delete(best);
  }

  let bestCost = pathCost(order, cost);
  for (let pass = 0, improved = true; improved && pass < 100; pass++) {
    improved = false;
    for (let i = 1; i < n - 1; i++) {
      for (let j = i + 1; j < n; j++) {
        const candidate = [
          ...order.slice(0, i),
          ...order.slice(i, j + 1).reverse(),
          ...order.slice(j + 1),
        ];
        const candidateCost = pathCost(candidate, cost);
        if (candidateCost < bestCost - 1e-9) {
          order.splice(0, n, ...candidate);
          bestCost = candidateCost;
          improved = true;
        }
      }
    }
  }
  return order;
}
