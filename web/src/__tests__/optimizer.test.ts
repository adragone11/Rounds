import { describe, it, expect } from 'vitest'
import {
  solveRoute,
  routeCost,
  removalSavings,
  cheapestInsertionCost,
  computeMoveSavings,
  solveRouteFromDepot,
  kMedoids,
  placeNewClients,
} from '../optimizer'

// 4-client matrix (minutes). Symmetric.
// Layout: A(0) and B(1) are close (2 min apart).
//         C(2) and D(3) are close (3 min apart).
//         The two clusters are ~20 min apart.
//
//    A    B    C    D
// A  0    2   20   22
// B  2    0   18   20
// C  20  18    0    3
// D  22  20    3    0
const matrix = [
  [0,  2, 20, 22],
  [2,  0, 18, 20],
  [20, 18,  0,  3],
  [22, 20,  3,  0],
]

describe('solveRoute', () => {
  it('returns empty for no clients', () => {
    const result = solveRoute([], matrix)
    expect(result.order).toEqual([])
    expect(result.cost).toBe(0)
  })

  it('returns single client with zero cost', () => {
    const result = solveRoute([2], matrix)
    expect(result.order).toEqual([2])
    expect(result.cost).toBe(0)
  })

  it('finds optimal order for two clusters', () => {
    // Optimal open path: A-B-C-D or reverse (cost = 2 + 18 + 3 = 23)
    // NOT A-C-B-D (cost = 20 + 18 + 20 = 58)
    const result = solveRoute([0, 1, 2, 3], matrix)
    expect(result.cost).toBe(23)
  })

  it('handles two clients', () => {
    const result = solveRoute([0, 1], matrix)
    expect(result.cost).toBe(2)
    expect(result.order).toHaveLength(2)
  })
})

describe('routeCost', () => {
  it('sums sequential edges in order', () => {
    expect(routeCost([0, 1, 2, 3], matrix)).toBe(2 + 18 + 3) // 23
    expect(routeCost([0, 2, 1, 3], matrix)).toBe(20 + 18 + 20) // 58
  })

  it('returns 0 for single or empty route', () => {
    expect(routeCost([], matrix)).toBe(0)
    expect(routeCost([2], matrix)).toBe(0)
  })
})

describe('removalSavings', () => {
  it('saves the detour cost of a middle client', () => {
    // Route: [0, 2, 1, 3]. Remove 2 (C, wedged between A and B).
    // Before: A->C(20) + C->B(18) = 38
    // After:  A->B(2)
    // Savings: 38 - 2 = 36
    expect(removalSavings(2, [0, 2, 1, 3], matrix)).toBe(36)
  })

  it('returns 0 when client is efficiently placed', () => {
    // Route: [0, 1, 2, 3]. Remove 1 (B, between A and C).
    // Before: A->B(2) + B->C(18) = 20
    // After:  A->C(20)
    // Savings: 20 - 20 = 0
    expect(removalSavings(1, [0, 1, 2, 3], matrix)).toBe(0)
  })

  it('saves the first edge when removing first client', () => {
    // Route: [0, 1, 2]. Remove 0.
    // Savings = dist(0,1) = 2
    expect(removalSavings(0, [0, 1, 2], matrix)).toBe(2)
  })

  it('saves the last edge when removing last client', () => {
    // Route: [0, 1, 2]. Remove 2.
    // Savings = dist(1,2) = 18
    expect(removalSavings(2, [0, 1, 2], matrix)).toBe(18)
  })

  it('returns 0 for single-client route', () => {
    expect(removalSavings(0, [0], matrix)).toBe(0)
  })
})

describe('cheapestInsertionCost', () => {
  it('returns 0 for empty route (first client on day)', () => {
    expect(cheapestInsertionCost(0, [], matrix)).toBe(0)
  })

  it('returns distance to single existing client', () => {
    // Insert A(0) into [C(2)]: either [0,2] or [2,0], cost = 20
    expect(cheapestInsertionCost(0, [2], matrix)).toBe(20)
  })

  it('finds cheapest position among several options', () => {
    // Insert A(0) into route [C(2), D(3)] (cost 3)
    // Before C: [0, 2, 3] -> adds dist(0,2) = 20
    // Between C,D: [2, 0, 3] -> adds 20 + 22 - 3 = 39
    // After D: [2, 3, 0] -> adds dist(3,0) = 22
    // Cheapest = 20 (before C)
    expect(cheapestInsertionCost(0, [2, 3], matrix)).toBe(20)
  })

  it('inserting near-cluster client is cheap', () => {
    // Insert B(1) into [A(0)]: cost = dist(0,1) = 2
    expect(cheapestInsertionCost(1, [0], matrix)).toBe(2)
  })
})

// 5-point matrix: clients A(0), B(1), C(2), D(3) + Home(4)
// Home is near the A/B cluster (5-7 min), far from C/D cluster (25-27 min)
const depotMatrix = [
  [0,  2, 20, 22,  5],
  [2,  0, 18, 20,  7],
  [20, 18,  0,  3, 25],
  [20, 20,  3,  0, 27],
  [5,  7, 25, 27,  0],
]

describe('computeMoveSavings', () => {
  it('big savings moving client from wrong cluster to right cluster', () => {
    // C(2) is on a day with route [0, 1, 2] (A→B→C, cost 2+18=20)
    // Target day has route [3] (D only)
    //
    // Removal of C from [0, 1, 2]: saves dist(1,2)=18 (last stop)
    // Insertion of C into [3]: cost = dist(2,3)=3
    // Net savings = 18 - 3 = 15
    expect(computeMoveSavings(2, [0, 1, 2], [3], matrix)).toBe(15)
  })

  it('negative savings for moving to wrong cluster', () => {
    // A(0) is on a day with route [0, 1] (cost 2)
    // Target day has route [2, 3] (C→D, cost 3)
    //
    // Removal of A from [0, 1]: saves dist(0,1)=2 (first stop)
    // Insertion of A into [2, 3]: cheapest = min(20, 22, 20+22-3=39) = 20
    // Net savings = 2 - 20 = -18
    expect(computeMoveSavings(0, [0, 1], [2, 3], matrix)).toBe(-18)
  })

  it('zero savings moving sole client to empty day', () => {
    // Removal from [0]: 0 (only client)
    // Insertion into []: 0 (first on new day)
    expect(computeMoveSavings(0, [0], [], matrix)).toBe(0)
  })
})

describe('solveRouteFromDepot', () => {
  it('returns depot-only route for no clients', () => {
    const result = solveRouteFromDepot(4, [], depotMatrix)
    expect(result.order).toEqual([4])
    expect(result.cost).toBe(0)
  })

  it('anchors route at depot then visits nearest', () => {
    const result = solveRouteFromDepot(4, [0, 1], depotMatrix)
    expect(result.order).toEqual([4, 0, 1])
    expect(result.cost).toBe(7)
  })

  it('visits far cluster correctly', () => {
    const result = solveRouteFromDepot(4, [2, 3], depotMatrix)
    expect(result.order).toEqual([4, 2, 3])
    expect(result.cost).toBe(28)
  })

  it('handles single client', () => {
    const result = solveRouteFromDepot(4, [2], depotMatrix)
    expect(result.order).toEqual([4, 2])
    expect(result.cost).toBe(25)
  })
})

describe('cheapestInsertionCost with fixedStart', () => {
  it('skips before-first when fixedStart is true', () => {
    expect(cheapestInsertionCost(2, [4, 0, 1], depotMatrix)).toBe(18)
    expect(cheapestInsertionCost(2, [4, 0, 1], depotMatrix, true)).toBe(18)
  })

  it('handles depot route insertion correctly', () => {
    expect(cheapestInsertionCost(0, [4, 2, 3], depotMatrix, true)).toBe(0)
  })
})

describe('computeMoveSavings with fixedStart', () => {
  it('correctly computes savings with depot routes', () => {
    expect(computeMoveSavings(2, [4, 2, 3], [4, 0, 1], depotMatrix, true)).toBe(-17)
  })
})

// ── K-Medoids tests ──

// 6-client matrix (minutes). Three geographic clusters:
//   Cluster 1: A(0), B(1) — 2 min apart
//   Cluster 2: C(2), D(3) — 3 min apart
//   Cluster 3: E(4), F(5) — 1 min apart
//   Inter-cluster distances: ~20-30 min
const clusterMatrix = [
  [0,  2, 20, 22, 28, 29],
  [2,  0, 18, 20, 26, 27],
  [20, 18,  0,  3, 25, 26],
  [22, 20,  3,  0, 23, 24],
  [28, 26, 25, 23,  0,  1],
  [29, 27, 26, 24,  1,  0],
]

describe('kMedoids', () => {
  it('returns empty for no clients', () => {
    expect(kMedoids([], clusterMatrix, 3)).toEqual([])
  })

  it('returns one cluster when k=1', () => {
    const clusters = kMedoids([0, 1, 2, 3, 4, 5], clusterMatrix, 1)
    expect(clusters).toHaveLength(1)
    expect(clusters[0].sort()).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('produces exactly k clusters', () => {
    const clusters = kMedoids([0, 1, 2, 3, 4, 5], clusterMatrix, 3)
    expect(clusters).toHaveLength(3)
  })

  it('groups nearby clients together', () => {
    const clusters = kMedoids([0, 1, 2, 3, 4, 5], clusterMatrix, 3)
    for (const cluster of clusters) {
      expect(cluster).toHaveLength(2)
      const [a, b] = cluster
      expect(clusterMatrix[a][b]).toBeLessThan(5)
    }
  })

  it('assigns all clients exactly once', () => {
    const clusters = kMedoids([0, 1, 2, 3, 4, 5], clusterMatrix, 3)
    const allClients = clusters.flat().sort()
    expect(allClients).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('handles k >= n (each client is own cluster)', () => {
    const clusters = kMedoids([0, 1, 2], clusterMatrix, 5)
    expect(clusters).toHaveLength(3)
    expect(clusters.every(c => c.length === 1)).toBe(true)
  })

  it('handles single client', () => {
    const clusters = kMedoids([3], clusterMatrix, 2)
    expect(clusters).toHaveLength(1)
    expect(clusters[0]).toEqual([3])
  })

  it('produces tighter clusters than random assignment', () => {
    const clusters = kMedoids([0, 1, 2, 3, 4, 5], clusterMatrix, 3)
    let totalIntra = 0
    for (const cluster of clusters) {
      for (let i = 0; i < cluster.length; i++) {
        for (let j = i + 1; j < cluster.length; j++) {
          totalIntra += clusterMatrix[cluster[i]][cluster[j]]
        }
      }
    }
    // The optimal grouping is {0,1}, {2,3}, {4,5} with total intra = 2+3+1 = 6
    expect(totalIntra).toBe(6)
  })
})

describe('placeNewClients', () => {
  it('assigns new client to the nearest existing day', () => {
    // Existing schedule: day 1 has clients 0,1 (close pair), day 2 has clients 2,3 (close pair)
    const existingDays = new Map<number, number>([[0, 1], [1, 1], [2, 2], [3, 2]])
    // Client 4 is closer to {2,3} (23-25 min) than {0,1} (26-28 min)
    const result = placeNewClients([4], existingDays, clusterMatrix, 5, [1, 2, 3])
    expect(result.get(4)).toBe(2)
  })

  it('respects maxPerDay', () => {
    const existingDays = new Map<number, number>([[0, 1], [1, 1], [2, 2], [3, 2]])
    // Max 2 per day — both days are full. Should go to day 3.
    const result = placeNewClients([4], existingDays, clusterMatrix, 2, [1, 2, 3])
    expect(result.get(4)).not.toBe(1)
    expect(result.get(4)).not.toBe(2)
  })

  it('places multiple new clients', () => {
    const existingDays = new Map<number, number>([[0, 1], [2, 2]])
    // Client 1 should join day 1 (near 0), client 3 should join day 2 (near 2)
    const result = placeNewClients([1, 3], existingDays, clusterMatrix, 5, [1, 2])
    expect(result.get(1)).toBe(1)
    expect(result.get(3)).toBe(2)
  })
})
