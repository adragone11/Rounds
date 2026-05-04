/**
 * Tests for the anchor date math used by bulkReassignDays,
 * grid week assignment, and the default start date formula.
 *
 * Real calendar reference (April 2026):
 *   Mon 13, Tue 14, Wed 15, Thu 16, Fri 17, Sat 18, Sun 19
 *   Mon 20, Tue 21, Wed 22, Thu 23, Fri 24, Sat 25, Sun 26
 */

function d(dateStr: string): Date {
  return new Date(dateStr + 'T00:00:00')
}

function fmt(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

// Replicate the core logic from store.tsx bulkReassignDays
function computeAnchor(
  targetDay: number,
  cycleStart: Date,
  rotation: number,
  freq: string,
): Date {
  const baseDate = new Date(cycleStart)
  const baseDow = baseDate.getDay()
  baseDate.setDate(baseDate.getDate() - ((baseDow + 6) % 7)) // snap to Monday

  const daysUntil = (targetDay - 1 + 7) % 7 // Monday-relative
  const anchorDate = new Date(baseDate)
  anchorDate.setDate(baseDate.getDate() + daysUntil)

  if (freq === 'biweekly' && rotation === 1) {
    anchorDate.setDate(anchorDate.getDate() + 7)
  }
  return anchorDate
}

// Replicate the default start date formula from ScheduleBuilder
function computeNextMonday(today: Date): Date {
  const result = new Date(today)
  const dayOfWeek = result.getDay()
  const daysUntilMonday = dayOfWeek === 1 ? 7 : (8 - dayOfWeek) % 7 || 7
  result.setDate(result.getDate() + daysUntilMonday)
  return result
}

// Replicate week assignment from optimizer grid builder
function getWeeks(freq: string, rotation: number, maxWeeks: number, intervalWeeks?: number): number[] {
  if (freq === 'weekly') {
    return Array.from({ length: maxWeeks }, (_, i) => i)
  } else if (freq === 'biweekly') {
    const start = rotation === 0 ? 0 : 1
    const weeks: number[] = []
    for (let w = start; w < maxWeeks; w += 2) weeks.push(w)
    return weeks
  } else if (freq === 'custom') {
    const interval = intervalWeeks ?? 4
    const weeks: number[] = []
    for (let w = 0; w < maxWeeks; w += interval) weeks.push(w)
    return weeks
  } else {
    return [0]
  }
}

describe('default start date formula', () => {
  test('Monday → next Monday (7 days)', () => {
    // Apr 13 is Monday → next Monday is Apr 20
    expect(fmt(computeNextMonday(d('2026-04-13')))).toBe('2026-04-20')
  })

  test('Tuesday → next Monday (6 days)', () => {
    expect(fmt(computeNextMonday(d('2026-04-14')))).toBe('2026-04-20')
  })

  test('Wednesday → next Monday (5 days)', () => {
    expect(fmt(computeNextMonday(d('2026-04-15')))).toBe('2026-04-20')
  })

  test('Thursday → next Monday (4 days)', () => {
    expect(fmt(computeNextMonday(d('2026-04-16')))).toBe('2026-04-20')
  })

  test('Friday → next Monday (3 days)', () => {
    expect(fmt(computeNextMonday(d('2026-04-17')))).toBe('2026-04-20')
  })

  test('Saturday → next Monday (2 days)', () => {
    expect(fmt(computeNextMonday(d('2026-04-18')))).toBe('2026-04-20')
  })

  test('Sunday → next Monday (1 day)', () => {
    expect(fmt(computeNextMonday(d('2026-04-19')))).toBe('2026-04-20')
  })
})

describe('anchor date math — Monday start', () => {
  // Apr 13, 2026 = Monday
  const monday = d('2026-04-13')

  test('Monday target → Mon Apr 13', () => {
    expect(fmt(computeAnchor(1, monday, 0, 'weekly'))).toBe('2026-04-13')
  })

  test('Tuesday target → Tue Apr 14', () => {
    expect(fmt(computeAnchor(2, monday, 0, 'weekly'))).toBe('2026-04-14')
  })

  test('Wednesday target → Wed Apr 15', () => {
    expect(fmt(computeAnchor(3, monday, 0, 'weekly'))).toBe('2026-04-15')
  })

  test('Thursday target → Thu Apr 16', () => {
    expect(fmt(computeAnchor(4, monday, 0, 'weekly'))).toBe('2026-04-16')
  })

  test('Friday target → Fri Apr 17', () => {
    expect(fmt(computeAnchor(5, monday, 0, 'weekly'))).toBe('2026-04-17')
  })

  test('Saturday target → Sat Apr 18', () => {
    expect(fmt(computeAnchor(6, monday, 0, 'weekly'))).toBe('2026-04-18')
  })

  test('Sunday target → Sun Apr 19', () => {
    expect(fmt(computeAnchor(0, monday, 0, 'weekly'))).toBe('2026-04-19')
  })
})

describe('anchor date math — biweekly rotations', () => {
  const monday = d('2026-04-13')

  test('rotation A on Tue → Apr 14', () => {
    expect(fmt(computeAnchor(2, monday, 0, 'biweekly'))).toBe('2026-04-14')
  })

  test('rotation B on Tue → Apr 21 (one week later)', () => {
    expect(fmt(computeAnchor(2, monday, 1, 'biweekly'))).toBe('2026-04-21')
  })

  test('rotation A on Mon → Apr 13', () => {
    expect(fmt(computeAnchor(1, monday, 0, 'biweekly'))).toBe('2026-04-13')
  })

  test('rotation B on Mon → Apr 20', () => {
    expect(fmt(computeAnchor(1, monday, 1, 'biweekly'))).toBe('2026-04-20')
  })

  test('rotation A on Fri → Apr 17', () => {
    expect(fmt(computeAnchor(5, monday, 0, 'biweekly'))).toBe('2026-04-17')
  })

  test('rotation B on Fri → Apr 24', () => {
    expect(fmt(computeAnchor(5, monday, 1, 'biweekly'))).toBe('2026-04-24')
  })
})

describe('anchor date math — non-Monday start dates', () => {
  test('Wednesday start snaps to Monday', () => {
    const wed = d('2026-04-15')
    // Snap to Mon Apr 13, then target Monday = Apr 13
    expect(fmt(computeAnchor(1, wed, 0, 'weekly'))).toBe('2026-04-13')
  })

  test('Friday start, Thursday target', () => {
    const fri = d('2026-04-17')
    // Snap to Mon Apr 13, then target Thu = Apr 16
    expect(fmt(computeAnchor(4, fri, 0, 'weekly'))).toBe('2026-04-16')
  })

  test('Sunday start snaps to Monday of THAT week', () => {
    // Sunday Apr 19 → Monday of that week = Apr 13
    const sun = d('2026-04-19')
    expect(fmt(computeAnchor(3, sun, 0, 'weekly'))).toBe('2026-04-15') // Wed of Apr 13 week
  })

  test('Saturday start, biweekly rotation B', () => {
    const sat = d('2026-04-18')
    // Snap to Mon Apr 13, target Wed = Apr 15, +7 for rotation B = Apr 22
    expect(fmt(computeAnchor(3, sat, 1, 'biweekly'))).toBe('2026-04-22')
  })
})

describe('grid week assignment', () => {
  test('weekly 4 weeks → all weeks', () => {
    expect(getWeeks('weekly', 0, 4)).toEqual([0, 1, 2, 3])
  })

  test('weekly 6 weeks → all weeks', () => {
    expect(getWeeks('weekly', 0, 6)).toEqual([0, 1, 2, 3, 4, 5])
  })

  test('biweekly A 4 weeks → [0,2]', () => {
    expect(getWeeks('biweekly', 0, 4)).toEqual([0, 2])
  })

  test('biweekly B 4 weeks → [1,3]', () => {
    expect(getWeeks('biweekly', 1, 4)).toEqual([1, 3])
  })

  test('biweekly A 6 weeks → [0,2,4]', () => {
    expect(getWeeks('biweekly', 0, 6)).toEqual([0, 2, 4])
  })

  test('biweekly B 6 weeks → [1,3,5]', () => {
    expect(getWeeks('biweekly', 1, 6)).toEqual([1, 3, 5])
  })

  test('custom 3-week interval, 4 weeks → [0,3]', () => {
    expect(getWeeks('custom', 0, 4, 3)).toEqual([0, 3])
  })

  test('custom 6-week interval, 6 weeks → [0]', () => {
    expect(getWeeks('custom', 0, 6, 6)).toEqual([0])
  })

  test('custom 3-week interval, 9 weeks → [0,3,6]', () => {
    expect(getWeeks('custom', 0, 9, 3)).toEqual([0, 3, 6])
  })

  test('monthly → [0]', () => {
    expect(getWeeks('monthly', 0, 4)).toEqual([0])
  })

  test('one-time → [0]', () => {
    expect(getWeeks('one-time', 0, 4)).toEqual([0])
  })
})

describe('blocked days filtering', () => {
  // Replicate the blocked days check from optimizer
  function isBlocked(targetDay: number, blockedDays: number[]): boolean {
    return new Set(blockedDays).has(targetDay)
  }

  test('no blocked days → nothing blocked', () => {
    expect(isBlocked(1, [])).toBe(false)
    expect(isBlocked(5, [])).toBe(false)
  })

  test('Monday blocked → Monday returns true', () => {
    expect(isBlocked(1, [1])).toBe(true)
    expect(isBlocked(2, [1])).toBe(false)
  })

  test('multiple blocked days', () => {
    const blocked = [1, 3, 5] // Mon, Wed, Fri
    expect(isBlocked(1, blocked)).toBe(true)
    expect(isBlocked(2, blocked)).toBe(false)
    expect(isBlocked(3, blocked)).toBe(true)
    expect(isBlocked(4, blocked)).toBe(false)
    expect(isBlocked(5, blocked)).toBe(true)
  })

  test('all days blocked', () => {
    const blocked = [0, 1, 2, 3, 4, 5, 6]
    for (let d = 0; d < 7; d++) {
      expect(isBlocked(d, blocked)).toBe(true)
    }
  })
})

describe('max clients per day', () => {
  function canAddToDay(currentCount: number, maxPerDay: number): boolean {
    return maxPerDay <= 0 || currentCount < maxPerDay
  }

  test('under limit → can add', () => {
    expect(canAddToDay(3, 5)).toBe(true)
  })

  test('at limit → cannot add', () => {
    expect(canAddToDay(5, 5)).toBe(false)
  })

  test('over limit → cannot add', () => {
    expect(canAddToDay(6, 5)).toBe(false)
  })

  test('zero max → no limit (can always add)', () => {
    expect(canAddToDay(100, 0)).toBe(true)
  })

  test('one slot left → can add', () => {
    expect(canAddToDay(4, 5)).toBe(true)
  })
})
