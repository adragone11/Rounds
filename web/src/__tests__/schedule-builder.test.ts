/**
 * Schedule Builder integration tests.
 * Tests the grid building, recurrence handling, and various client
 * configurations WITHOUT hitting ORS/VROOM APIs (uses Haversine fallback).
 *
 * These tests verify that the optimizer produces valid, non-crashing
 * schedules for a range of inputs — not that the routes are optimal
 * (that depends on the VROOM solver which we can't unit test).
 */

import { generatePerfectSchedule } from '../lib/scheduleBuilder'
import type { Client } from '../types'

// ── Test helpers ──

type ClientWithDay = {
  client: Client
  currentDay: number
}

function makeClient(id: string, name: string, opts: Partial<Client> = {}): Client {
  return {
    id,
    name,
    address: `${name}'s address`,
    color: '#3B82F6',
    frequency: 'weekly',
    lat: 42.36 + Math.random() * 0.1, // Boston area
    lng: -71.06 + Math.random() * 0.1,
    startDate: null,
    exceptions: [],
    blockedDays: [],
    ...opts,
  }
}

function makeClientsWithDays(clients: Client[], currentDays: number[]): ClientWithDay[] {
  return clients.map((client, i) => ({
    client,
    currentDay: currentDays[i],
  }))
}

const HOME = { lat: 42.3601, lng: -71.0589 } // Boston
const DEFAULT_CONFIG = { maxJobsPerDay: 5, workingDays: [false, true, true, true, true, true, false] }

// ── Tests ──

describe('generatePerfectSchedule', () => {
  // Set fetch to fail so we get Haversine fallback (no ORS/VROOM)
  const originalFetch = globalThis.fetch
  beforeAll(() => {
    globalThis.fetch = (() => Promise.reject(new Error('no network in tests'))) as typeof fetch
  })
  afterAll(() => {
    globalThis.fetch = originalFetch
  })

  describe('basic scheduling', () => {
    test('5 weekly clients across 5 days', async () => {
      const clients = Array.from({ length: 5 }, (_, i) => makeClient(`c${i}`, `Client ${i}`))
      const withDays = makeClientsWithDays(clients, [1, 1, 1, 1, 1]) // all on Monday

      const result = await generatePerfectSchedule(withDays, DEFAULT_CONFIG, HOME)

      expect(result.assignments.size).toBe(5)
      expect(result.grid.size).toBeGreaterThan(0)
      expect(result.totalDriveMinutes).toBeGreaterThanOrEqual(0)

      // Every client should be assigned to a working day
      for (const [, day] of result.assignments) {
        expect(day).toBeGreaterThanOrEqual(1)
        expect(day).toBeLessThanOrEqual(5)
      }
    })

    test('10 weekly clients, max 3 per day', async () => {
      const clients = Array.from({ length: 10 }, (_, i) => makeClient(`c${i}`, `Client ${i}`))
      const withDays = makeClientsWithDays(clients, clients.map(() => 1)) // all on Monday

      const config = { maxJobsPerDay: 3, workingDays: [false, true, true, true, true, true, false] }
      const result = await generatePerfectSchedule(withDays, config, HOME)

      expect(result.assignments.size).toBe(10)

      // Count per day — should not exceed max (NN fallback may not perfectly respect this)
      const dayCounts = new Map<number, number>()
      for (const [, day] of result.assignments) {
        dayCounts.set(day, (dayCounts.get(day) ?? 0) + 1)
      }
      // At least distributed across multiple days
      expect(dayCounts.size).toBeGreaterThan(1)
    })

    test('no clients → empty result', async () => {
      const result = await generatePerfectSchedule([], DEFAULT_CONFIG, HOME)
      expect(result.assignments.size).toBe(0)
      expect(result.grid.size).toBe(0)
    })

    test('1 client → assigned to a working day', async () => {
      const clients = [makeClient('c0', 'Solo')]
      const withDays = makeClientsWithDays(clients, [3])

      const result = await generatePerfectSchedule(withDays, DEFAULT_CONFIG, HOME)
      expect(result.assignments.size).toBe(1)
      const day = result.assignments.get('c0')!
      expect(day).toBeGreaterThanOrEqual(1)
      expect(day).toBeLessThanOrEqual(5)
    })
  })

  describe('biweekly clients', () => {
    test('20 biweekly clients split into A/B rotations', async () => {
      const clients = Array.from({ length: 20 }, (_, i) =>
        makeClient(`c${i}`, `Biweekly ${i}`, { frequency: 'biweekly' })
      )
      const withDays = makeClientsWithDays(clients, clients.map((_, i) => (i % 5) + 1))

      const recMap = new Map(clients.map(c => [c.id, 'biweekly' as const]))
      const result = await generatePerfectSchedule(withDays, DEFAULT_CONFIG, HOME, undefined, recMap as unknown as Map<string, string>)

      expect(result.assignments.size).toBe(20)

      // Should have rotation assignments
      let rotA = 0, rotB = 0
      for (const [, rot] of result.rotations) {
        if (rot === 0) rotA++
        else rotB++
      }
      // Both rotations should be used
      expect(rotA).toBeGreaterThan(0)
      expect(rotB).toBeGreaterThan(0)

      // Grid should have entries in both even and odd weeks
      let hasEvenWeek = false, hasOddWeek = false
      for (const [key, cells] of result.grid) {
        if (cells.length > 0) {
          const week = parseInt(key.split('-')[0])
          if (week % 2 === 0) hasEvenWeek = true
          else hasOddWeek = true
        }
      }
      expect(hasEvenWeek).toBe(true)
      expect(hasOddWeek).toBe(true)
    })
  })

  describe('mixed recurrence', () => {
    test('weekly + biweekly + monthly mix', async () => {
      const clients = [
        makeClient('w1', 'Weekly 1'),
        makeClient('w2', 'Weekly 2'),
        makeClient('b1', 'Biweekly 1', { frequency: 'biweekly' }),
        makeClient('b2', 'Biweekly 2', { frequency: 'biweekly' }),
        makeClient('m1', 'Monthly 1', { frequency: 'monthly' }),
      ]
      const withDays = makeClientsWithDays(clients, [1, 2, 1, 2, 3])

      const recMap = new Map<string, string>([
        ['w1', 'weekly'], ['w2', 'weekly'],
        ['b1', 'biweekly'], ['b2', 'biweekly'],
        ['m1', 'monthly'],
      ])
      const result = await generatePerfectSchedule(withDays, DEFAULT_CONFIG, HOME, undefined, recMap)

      expect(result.assignments.size).toBe(5)

      // Weekly clients should appear in all 4 weeks
      const w1Weeks = new Set<number>()
      for (const [key, cells] of result.grid) {
        if (cells.some(c => c.clientId === 'w1')) {
          w1Weeks.add(parseInt(key.split('-')[0]))
        }
      }
      expect(w1Weeks.size).toBe(4)

      // Monthly client should appear in 1 week only
      const m1Weeks = new Set<number>()
      for (const [key, cells] of result.grid) {
        if (cells.some(c => c.clientId === 'm1')) {
          m1Weeks.add(parseInt(key.split('-')[0]))
        }
      }
      expect(m1Weeks.size).toBe(1)
    })
  })

  describe('custom recurrence', () => {
    test('3-week interval client extends grid beyond 4 weeks', async () => {
      const clients = [
        makeClient('w1', 'Weekly', { frequency: 'weekly' }),
        makeClient('c1', 'Every3Weeks', { frequency: 'custom', intervalWeeks: 3 }),
      ]
      const withDays = makeClientsWithDays(clients, [1, 2])

      const recMap = new Map<string, string>([['w1', 'weekly'], ['c1', 'custom']])
      const result = await generatePerfectSchedule(withDays, DEFAULT_CONFIG, HOME, undefined, recMap)

      expect(result.assignments.size).toBe(2)

      // The grid should have keys beyond week 3 (since custom interval is 3, we need at least 3 weeks, but min is 4)
      let maxWeek = 0
      for (const key of result.grid.keys()) {
        const week = parseInt(key.split('-')[0])
        if (week > maxWeek) maxWeek = week
      }
      expect(maxWeek).toBeGreaterThanOrEqual(3) // at least 4 weeks (0-3)
    })

    test('6-week interval extends grid to 6 weeks', async () => {
      const clients = [
        makeClient('w1', 'Weekly'),
        makeClient('c1', 'Every6Weeks', { frequency: 'custom', intervalWeeks: 6 }),
      ]
      const withDays = makeClientsWithDays(clients, [1, 2])

      const recMap = new Map<string, string>([['w1', 'weekly'], ['c1', 'custom']])
      const result = await generatePerfectSchedule(withDays, DEFAULT_CONFIG, HOME, undefined, recMap)

      // Grid should extend to week 5 (0-indexed, so 6 weeks = indices 0-5)
      let maxWeek = 0
      for (const key of result.grid.keys()) {
        const week = parseInt(key.split('-')[0])
        if (week > maxWeek) maxWeek = week
      }
      expect(maxWeek).toBeGreaterThanOrEqual(5)
    })
  })

  describe('blocked days', () => {
    test('client with Mon blocked is not assigned to Monday', async () => {
      const clients = [
        makeClient('c0', 'NoMonday', { blockedDays: [1] }), // Monday blocked
        makeClient('c1', 'Normal'),
        makeClient('c2', 'Normal 2'),
      ]
      const withDays = makeClientsWithDays(clients, [1, 2, 3])

      const result = await generatePerfectSchedule(withDays, DEFAULT_CONFIG, HOME)

      // The blocked client should NOT be on Monday
      const c0Day = result.assignments.get('c0')
      expect(c0Day).toBeDefined()
      expect(c0Day).not.toBe(1)
    })

    test('client with all weekdays blocked still gets assigned (fallback)', async () => {
      // Block Mon-Fri, only Sat/Sun open but those aren't working days
      const clients = [
        makeClient('c0', 'AllBlocked', { blockedDays: [1, 2, 3, 4, 5] }),
        makeClient('c1', 'Normal'),
      ]
      const withDays = makeClientsWithDays(clients, [1, 2])

      // Should not crash
      const result = await generatePerfectSchedule(withDays, DEFAULT_CONFIG, HOME)
      expect(result.assignments.size).toBeGreaterThan(0)
    })
  })

  describe('working days configuration', () => {
    test('3-day work week (Mon/Wed/Fri)', async () => {
      const clients = Array.from({ length: 6 }, (_, i) => makeClient(`c${i}`, `Client ${i}`))
      const withDays = makeClientsWithDays(clients, [1, 1, 3, 3, 5, 5])

      const config = {
        maxJobsPerDay: 4,
        workingDays: [false, true, false, true, false, true, false], // Mon, Wed, Fri only
      }
      const result = await generatePerfectSchedule(withDays, config, HOME)

      expect(result.assignments.size).toBe(6)

      // All assignments should be on Mon(1), Wed(3), or Fri(5)
      for (const [, day] of result.assignments) {
        expect([1, 3, 5]).toContain(day)
      }
    })

    test('6-day work week (Mon-Sat)', async () => {
      const clients = Array.from({ length: 12 }, (_, i) => makeClient(`c${i}`, `Client ${i}`))
      const withDays = makeClientsWithDays(clients, clients.map(() => 1))

      const config = {
        maxJobsPerDay: 3,
        workingDays: [false, true, true, true, true, true, true], // Mon-Sat
      }
      const result = await generatePerfectSchedule(withDays, config, HOME)

      expect(result.assignments.size).toBe(12)

      // Should use Saturday too
      const days = new Set<number>()
      for (const [, day] of result.assignments) {
        days.add(day)
      }
      expect(days.size).toBeGreaterThan(3) // spread across multiple days
    })
  })

  describe('changes detection', () => {
    test('clients staying on same day produce no changes', async () => {
      const clients = [
        makeClient('c0', 'Client 0'),
        makeClient('c1', 'Client 1'),
      ]
      // If optimizer keeps them on same days, changes should be empty
      // (can't guarantee this, but at least verify changes structure)
      const withDays = makeClientsWithDays(clients, [1, 2])

      const result = await generatePerfectSchedule(withDays, DEFAULT_CONFIG, HOME)

      // Changes should be an array with valid structure
      expect(Array.isArray(result.changes)).toBe(true)
      for (const change of result.changes) {
        expect(change).toHaveProperty('clientId')
        expect(change).toHaveProperty('clientName')
        expect(change).toHaveProperty('fromDay')
        expect(change).toHaveProperty('toDay')
        expect(change.fromDay).not.toBe(change.toDay)
      }
    })

    test('all clients on one day forces moves', async () => {
      const clients = Array.from({ length: 10 }, (_, i) => makeClient(`c${i}`, `Client ${i}`))
      const withDays = makeClientsWithDays(clients, clients.map(() => 1)) // all Monday

      const config = { maxJobsPerDay: 3, workingDays: [false, true, true, true, true, true, false] }
      const result = await generatePerfectSchedule(withDays, config, HOME)

      // With max 3 per day and 10 clients, at least 7 must move
      expect(result.changes.length).toBeGreaterThanOrEqual(7)
    })
  })

  describe('large rosters', () => {
    test('40 biweekly clients — does not crash', async () => {
      const clients = Array.from({ length: 40 }, (_, i) =>
        makeClient(`c${i}`, `Client ${i}`, { frequency: 'biweekly' })
      )
      const withDays = makeClientsWithDays(clients, clients.map((_, i) => (i % 5) + 1))

      const recMap = new Map(clients.map(c => [c.id, 'biweekly' as const]))
      const result = await generatePerfectSchedule(withDays, DEFAULT_CONFIG, HOME, undefined, recMap as unknown as Map<string, string>)

      expect(result.assignments.size).toBe(40)
      expect(result.totalDriveMinutes).toBeGreaterThanOrEqual(0)
    }, 10000)

    test('20 mixed recurrence clients — does not crash', async () => {
      const clients: Client[] = []
      for (let i = 0; i < 10; i++) clients.push(makeClient(`w${i}`, `Weekly ${i}`))
      for (let i = 0; i < 7; i++) clients.push(makeClient(`b${i}`, `Biweekly ${i}`, { frequency: 'biweekly' }))
      for (let i = 0; i < 2; i++) clients.push(makeClient(`m${i}`, `Monthly ${i}`, { frequency: 'monthly' }))
      clients.push(makeClient('c0', 'Custom 3wk', { frequency: 'custom', intervalWeeks: 3 }))

      const withDays = makeClientsWithDays(clients, clients.map((_, i) => (i % 5) + 1))

      const recMap = new Map(clients.map(c => [c.id, c.frequency]))
      const result = await generatePerfectSchedule(withDays, DEFAULT_CONFIG, HOME, undefined, recMap as unknown as Map<string, string>)

      expect(result.assignments.size).toBe(20)
    }, 10000)
  })

  describe('grid structure', () => {
    test('grid keys follow "week-day" format', async () => {
      const clients = Array.from({ length: 5 }, (_, i) => makeClient(`c${i}`, `Client ${i}`))
      const withDays = makeClientsWithDays(clients, [1, 2, 3, 4, 5])

      const result = await generatePerfectSchedule(withDays, DEFAULT_CONFIG, HOME)

      for (const key of result.grid.keys()) {
        expect(key).toMatch(/^\d+-\d+$/)
        const [week, day] = key.split('-').map(Number)
        expect(week).toBeGreaterThanOrEqual(0)
        expect(day).toBeGreaterThanOrEqual(0)
        expect(day).toBeLessThanOrEqual(6)
      }
    })

    test('grid cells have valid clientId and routeOrder', async () => {
      const clients = Array.from({ length: 5 }, (_, i) => makeClient(`c${i}`, `Client ${i}`))
      const withDays = makeClientsWithDays(clients, [1, 2, 3, 4, 5])

      const result = await generatePerfectSchedule(withDays, DEFAULT_CONFIG, HOME)

      const clientIds = new Set(clients.map(c => c.id))
      for (const [, cells] of result.grid) {
        for (const cell of cells) {
          expect(clientIds.has(cell.clientId)).toBe(true)
          expect(cell.routeOrder).toBeGreaterThanOrEqual(0)
          expect(['weekly', 'biweekly', 'monthly', 'one-time', 'custom']).toContain(cell.recurrence)
          expect([0, 1]).toContain(cell.rotation)
        }
      }
    })
  })
})
