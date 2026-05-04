import { describe, it, expect } from 'vitest'
import { buildSchedulePlan } from '../store'
import type { Client } from '../types'

const mkClient = (id: string, name: string): Client => ({
  id,
  name,
  address: '1 Main St',
  color: '#000',
  frequency: 'weekly',
  lat: 0,
  lng: 0,
  startDate: '2026-01-05',
  exceptions: [],
  blockedDays: [],
})

describe('buildSchedulePlan', () => {
  it('captures Builder output without mutating inputs', () => {
    const clients = [mkClient('a', 'Alice'), mkClient('b', 'Bob')]
    const assignments = new Map<string, number>([['a', 1], ['b', 3]])
    const rotations = new Map<string, number>([['a', 0], ['b', 1]])
    const rec = new Map<string, Client['frequency']>([['a', 'weekly'], ['b', 'biweekly']])
    const intervals = new Map<string, number>([['a', 1], ['b', 2]])

    const plan = buildSchedulePlan(clients, assignments, rotations, rec, intervals)

    expect(plan.status).toBe('active')
    expect(plan.rosterSnapshot).toEqual(['a', 'b'])
    expect(plan.clients).toHaveLength(2)
    expect(plan.clients[0]).toMatchObject({
      clientId: 'a',
      plannedDay: 1,
      originalPlannedDay: 1,
      plannedRotation: 0,
      status: 'pending',
    })
  })

  it('excludes benched clients (day = -1)', () => {
    const clients = [mkClient('a', 'Alice'), mkClient('b', 'Bob')]
    const assignments = new Map<string, number>([['a', 1], ['b', -1]])
    const rotations = new Map<string, number>([['a', 0], ['b', 0]])
    const rec = new Map<string, Client['frequency']>([['a', 'weekly'], ['b', 'weekly']])
    const intervals = new Map<string, number>([['a', 1], ['b', 1]])

    const plan = buildSchedulePlan(clients, assignments, rotations, rec, intervals)

    expect(plan.clients.map(c => c.clientId)).toEqual(['a'])
    expect(plan.rosterSnapshot).toEqual(['a', 'b'])
  })
})
