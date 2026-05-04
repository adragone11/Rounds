import { useEffect } from 'react'
import { ROUTE_COLOR } from '../theme'
import type { RouteData } from '../lib/scheduleReducers'

type ClientLike = { lat: number | null; lng: number | null }
type StoreLike = {
  getClientsForDate: (date: string) => ClientLike[]
  homeAddress: { lat: number; lng: number } | null
}

/**
 * Fetches a driving route through the day's clients (home → nearest-neighbor)
 * and pushes the result up via `onRouteData`. Pass null when there's nothing
 * to draw — e.g. no date selected, no clients with coords, no home address —
 * and the consumer should clear its route state.
 *
 * Lifted out of Schedule.tsx so the effect can be tested + reused without
 * reaching into the page's UI reducer.
 */
export function useRouteData(
  routeDate: string | null,
  store: StoreLike,
  onRouteData: (data: RouteData | null) => void,
) {
  useEffect(() => {
    if (!routeDate) { onRouteData(null); return }

    const clients = store.getClientsForDate(routeDate)
    const withCoords = clients.filter(c => c.lat !== null && c.lng !== null)
    if (withCoords.length < 1 || !store.homeAddress) { onRouteData(null); return }

    let cancelled = false

    // Build coordinate list: home → clients (nearest-neighbor order), no return trip.
    const home = { lat: store.homeAddress.lat, lng: store.homeAddress.lng }
    const ordered: Array<{ lat: number; lng: number }> = [home]
    const remaining = withCoords.map(c => ({ lat: c.lat!, lng: c.lng! }))

    let current = home
    while (remaining.length > 0) {
      let bestIdx = 0
      let bestDist = Infinity
      for (let i = 0; i < remaining.length; i++) {
        const d = (remaining[i]!.lat - current.lat) ** 2 + (remaining[i]!.lng - current.lng) ** 2
        if (d < bestDist) { bestDist = d; bestIdx = i }
      }
      current = remaining.splice(bestIdx, 1)[0]!
      ordered.push(current)
    }

    const coordinates = ordered.map(c => [c.lng, c.lat]) // ORS wants [lng, lat]

    fetch('/api/ors-directions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ coordinates }),
    })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (cancelled || !data?.coordinates?.length) return
        onRouteData({
          coordinates: data.coordinates,
          durationMinutes: data.durationMinutes,
          distanceMiles: data.distanceMiles,
          color: ROUTE_COLOR,
        })
      })
      .catch(() => {})

    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeDate])
}
