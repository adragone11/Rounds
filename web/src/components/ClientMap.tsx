import { memo, useEffect, useRef, useMemo, useState } from 'react'
import type { Client, ProposedMove } from '../types'
import { useTheme } from '../lib/theme'
import { computeOverlapMap, fanOutCoord, computeBadgeOpacity } from '../lib/mapClustering'

const UNPLACED_COLOR = '#9CA3AF'

// ── MapKit JS loader (singleton) ──

let mapkitLoaded = false
let mapkitInitialized = false
let loadPromise: Promise<void> | null = null

function loadMapKit(): Promise<void> {
  if (mapkitLoaded) return Promise.resolve()
  if (loadPromise) return loadPromise
  loadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'https://cdn.apple-mapkit.com/mk/5.x.x/mapkit.js'
    script.crossOrigin = 'anonymous'
    script.onload = () => { mapkitLoaded = true; resolve() }
    script.onerror = () => reject(new Error('Failed to load MapKit JS'))
    document.head.appendChild(script)
  })
  return loadPromise
}

async function initMapKit(): Promise<void> {
  await loadMapKit()
  if (mapkitInitialized) return
  return new Promise((resolve, reject) => {
    mapkit.init({
      authorizationCallback: async (done: (token: string) => void) => {
        try {
          const res = await fetch('/api/mapkit-token')
          if (!res.ok) {
            const text = await res.text()
            console.error('[MapKit] Token fetch failed:', res.status, text)
            reject(new Error(`Token fetch failed: ${res.status}`))
            return
          }
          const { token, error } = await res.json()
          if (error) {
            console.error('[MapKit] Token error:', error)
            reject(new Error(error))
            return
          }
          done(token)
        } catch (err) {
          console.error('[MapKit] Init error:', err)
          reject(err)
        }
      },
    })
    mapkitInitialized = true
    resolve()
  })
}

// ── Component ──

const DEFAULT_DAY_COLORS = ['#F97316', '#3B82F6', '#EF4444', '#10B981', '#8B5CF6', '#EC4899', '#06B6D4']

interface RouteData {
  coordinates: Array<{ lat: number; lng: number }>
  durationMinutes: number | null
  distanceMiles: number | null
  color: string
}

interface ClientMapProps {
  clients: Client[]
  placedClientIds: Set<string>
  clientDayColorMap: Map<string, string>
  /** Placed clients with no occurrences in the viewed month — pin dimmed, color kept. */
  offMonthClientIds?: Set<string>
  highlightedClientIds: Set<string> | null
  /** Emphasize one pin (larger + ring) without dimming others. Independent of highlightedClientIds. */
  emphasizedClientId?: string | null
  selectedDateLabel: string | null
  onPinClick?: (clientId: string) => void
  homeAddress?: { lat: number; lng: number } | null
  singleClientSelected?: boolean // true when one client is selected (show name), false for day selection (no names)
  previewMoves?: ProposedMove[]
  route?: RouteData | null
  /** Per-weekday palette (Sun..Sat). Falls back to built-in defaults. */
  dayColors?: string[]
}

function ClientMap({ clients, placedClientIds, clientDayColorMap, offMonthClientIds, highlightedClientIds, emphasizedClientId, selectedDateLabel, onPinClick, homeAddress, singleClientSelected, previewMoves = [], route, dayColors }: ClientMapProps) {
  const DAY_COLORS = dayColors && dayColors.length === 7 ? dayColors : DEFAULT_DAY_COLORS
  const { theme } = useTheme()
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<mapkit.Map | null>(null)
  const initialFitDone = useRef(false)
  const prevClientIdsRef = useRef<string>('')
  const annotationMapRef = useRef<Map<string, { annotation: mapkit.Annotation; dot: HTMLElement; tooltip: HTMLElement; badge: HTMLElement | null }>>(new Map())
  const homeAnnotationRef = useRef<mapkit.Annotation | null>(null)
  const routeOverlayRef = useRef<mapkit.PolylineOverlay | null>(null)
  const [mapReady, setMapReady] = useState(false)

  const withCoords = useMemo(() => clients.filter(c => c.lat !== null && c.lng !== null), [clients])
  const hasHighlight = highlightedClientIds !== null

  const highlightedClients = useMemo(() => {
    if (!highlightedClientIds) return null
    return withCoords.filter(c => highlightedClientIds.has(c.id))
  }, [withCoords, highlightedClientIds])

  const overlapMap = useMemo(
    () => computeOverlapMap(withCoords, c => c.id, c => c.lat!, c => c.lng!),
    [withCoords],
  )

  // Latitude span (degrees) of the visible region. Drives count-badge fade.
  // Defaults to a value above BADGE_FADE_IN so badges show before first region sync.
  const [zoomDelta, setZoomDelta] = useState(0.1)

  const onPinClickRef = useRef(onPinClick)
  onPinClickRef.current = onPinClick

  // Inject pulse animation CSS (once)
  useEffect(() => {
    if (document.getElementById('pip-pulse-style')) return
    const style = document.createElement('style')
    style.id = 'pip-pulse-style'
    style.textContent = `
      @keyframes pip-pulse {
        0%, 100% { transform: scale(1); opacity: 1; }
        50% { transform: scale(1.3); opacity: 0.85; }
      }
    `
    document.head.appendChild(style)
  }, [])

  // Initialize map
  useEffect(() => {
    if (!containerRef.current) return
    let cancelled = false

    initMapKit().then(() => {
      if (cancelled || !containerRef.current || mapRef.current) return
      const map = new mapkit.Map(containerRef.current, {
        showsCompass: mapkit.FeatureVisibility.Hidden,
        showsZoomControl: false,
        showsMapTypeControl: false,
        colorScheme: theme === 'dark' ? mapkit.Map.ColorSchemes.Dark : mapkit.Map.ColorSchemes.Light,
        mapType: mapkit.Map.MapTypes.Standard,
        pointOfInterestFilter: mapkit.PointOfInterestFilter.excludingAll,
      })
      mapRef.current = map
      setMapReady(true)
    }).catch(err => console.error('MapKit init failed:', err))

    return () => {
      cancelled = true
      if (mapRef.current) {
        mapRef.current.destroy()
        mapRef.current = null
        initialFitDone.current = false
        annotationMapRef.current.clear()
        setMapReady(false)
      }
    }
  }, [])

  // Re-skin live when the user toggles theme (MapKit exposes colorScheme
  // as a settable property; no re-init needed).
  useEffect(() => {
    if (!mapReady) return
    const map = mapRef.current
    if (!map) return
    // `colorScheme` is settable on mapkit.Map at runtime but missing from
    // the bundled type defs.
    ;(map as unknown as { colorScheme: string }).colorScheme =
      theme === 'dark' ? mapkit.Map.ColorSchemes.Dark : mapkit.Map.ColorSchemes.Light
  }, [theme, mapReady])

  // ── Sync annotations ──
  useEffect(() => {
    if (!mapReady) return
    const map = mapRef.current
    if (!map) return

    const currentIds = new Set(withCoords.map(c => c.id))
    const existingIds = new Set(annotationMapRef.current.keys())

    // Remove annotations for clients no longer present
    for (const id of existingIds) {
      if (!currentIds.has(id)) {
        const entry = annotationMapRef.current.get(id)
        if (entry) {
          map.removeAnnotation(entry.annotation)
          annotationMapRef.current.delete(id)
        }
      }
    }

    // Add annotations for new clients
    const newAnnotations: mapkit.Annotation[] = []

    for (const client of withCoords) {
      if (annotationMapRef.current.has(client.id)) continue

      const overlap = overlapMap[client.id] ?? { count: 1, index: 0 }
      const fan = fanOutCoord(client.lat!, client.lng!, overlap)
      const coord = new mapkit.Coordinate(fan.latitude, fan.longitude)

      const wrapper = document.createElement('div')
      wrapper.style.cssText = `
        position: relative;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
      `

      const dot = document.createElement('div')
      dot.style.cssText = `
        width: 14px; height: 14px; border-radius: 50%;
        background: #9CA3AF; border: 2.5px solid white;
        box-shadow: 0 1px 3px rgba(0,0,0,0.12);
        cursor: pointer;
        box-sizing: border-box;
        flex: 0 0 auto;
        aspect-ratio: 1 / 1;
        transform: translateZ(0);
      `

      const tooltip = document.createElement('div')
      tooltip.textContent = client.name
      tooltip.style.cssText = `
        position: absolute; bottom: 20px; left: 50%;
        transform: translateX(-50%);
        background: white; color: #1f2937;
        font-weight: 600; font-size: 13px; white-space: nowrap;
        padding: 4px 10px; border-radius: 10px;
        box-shadow: 0 2px 6px rgba(0,0,0,0.15);
        pointer-events: none; opacity: 0;
        transition: opacity 0.15s;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      `

      wrapper.addEventListener('mouseenter', () => { tooltip.style.opacity = '1' })
      wrapper.addEventListener('mouseleave', () => {
        if (!(wrapper as any)._isHighlighted) tooltip.style.opacity = '0'
      })

      const cid = client.id
      wrapper.addEventListener('click', (e) => {
        e.stopPropagation()
        onPinClickRef.current?.(cid)
      })

      wrapper.appendChild(tooltip)
      wrapper.appendChild(dot)

      // Cluster-count badge: only when this pin shares a ~110m grid cell with others.
      let badge: HTMLElement | null = null
      if (overlap.count > 1) {
        badge = document.createElement('div')
        badge.textContent = String(overlap.count)
        badge.style.cssText = `
          position: absolute; top: -2px; right: -2px;
          min-width: 16px; height: 16px; padding: 0 4px;
          background: #1f2937; color: white;
          border: 1.5px solid white; border-radius: 999px;
          font-size: 10px; font-weight: 700; line-height: 13px;
          text-align: center; pointer-events: none;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          box-shadow: 0 1px 2px rgba(0,0,0,0.2);
          box-sizing: border-box;
          opacity: ${computeBadgeOpacity(zoomDelta)};
          transition: opacity 0.12s linear;
          transform: translateZ(0);
        `
        wrapper.appendChild(badge)
      }

      const annotation = new mapkit.Annotation(coord, () => wrapper, {
        anchorOffset: new DOMPoint(0, 0),
        enabled: false,
      })

      annotationMapRef.current.set(client.id, { annotation, dot, tooltip, badge })
      newAnnotations.push(annotation)
    }

    if (newAnnotations.length > 0) {
      map.addAnnotations(newAnnotations)
    }

    // ── Update visual state (fast CSS-only updates) ──
    for (const client of withCoords) {
      const entry = annotationMapRef.current.get(client.id)
      if (!entry) continue

      const isPlaced = placedClientIds.has(client.id)
      const isHighlighted = highlightedClientIds?.has(client.id) ?? false
      const isEmphasized = emphasizedClientId === client.id
      const isDimmed = hasHighlight && !isHighlighted
      const isOffMonth = offMonthClientIds?.has(client.id) ?? false
      const previewMatch = previewMoves.find(m => m.clientId === client.id)
      const isPreviewTarget = !!previewMatch
      const baseColor = isPlaced ? (clientDayColorMap.get(client.id) ?? client.color) : UNPLACED_COLOR
      const color = isPreviewTarget ? DAY_COLORS[previewMatch!.suggestedDay] : baseColor

      const hasPreview = previewMoves.length > 0
      const isDimmedByPreview = hasPreview && !isPreviewTarget
      const size = isPreviewTarget ? 20 : (isHighlighted || isEmphasized) ? 18 : 14
      const borderWidth = isPreviewTarget ? 3 : (isHighlighted || isEmphasized) ? 3 : 2.5
      // Off-month dim is opacity-only — color is preserved so the owner can still
      // tell a Monday-client from a Tuesday-client.
      const opacity = isDimmedByPreview ? 0.25 : isDimmed ? 0.35 : isOffMonth ? 0.4 : 1

      entry.dot.style.width = `${size}px`
      entry.dot.style.height = `${size}px`
      entry.dot.style.background = isDimmed ? '#D1D5DB' : color
      entry.dot.style.borderWidth = `${borderWidth}px`
      entry.dot.style.opacity = String(opacity)
      entry.dot.style.animation = isPreviewTarget ? 'pip-pulse 1.5s ease-in-out infinite' : 'none'
      entry.dot.style.boxShadow = isPreviewTarget
        ? `0 0 0 4px ${color}40, 0 1px 4px rgba(0,0,0,0.15)`
        : isEmphasized
          ? `0 0 0 4px ${color}40, 0 1px 4px rgba(0,0,0,0.15)`
          : `0 1px ${isDimmed ? 2 : 3}px rgba(0,0,0,${isDimmed ? 0.06 : 0.12})`

      const wrapper = entry.dot.parentElement
      if (wrapper?.parentElement) {
        wrapper.parentElement.style.zIndex = isPreviewTarget ? '1001' : (isHighlighted || isEmphasized) ? '1000' : isDimmed ? '1' : '10'
      }

      entry.tooltip.style.bottom = `${size + 6}px`
      // Tooltip pill only appears for preview targets (schedule optimizer previews).
      // Selection highlights the circle itself — no pill — so the pin stays round.
      entry.tooltip.style.opacity = isPreviewTarget ? '1' : '0'
      // Only preview targets pin the tooltip open; selection lets mouseleave hide it.
      ;(wrapper as any)._isHighlighted = isPreviewTarget
    }

    // ── Fit bounds only when client list changes ──
    const clientIdKey = withCoords.map(c => c.id).sort().join(',')
    if (clientIdKey !== prevClientIdsRef.current || !initialFitDone.current) {
      prevClientIdsRef.current = clientIdKey
      const targets = highlightedClients && highlightedClients.length > 0 ? highlightedClients : withCoords
      const targetCoords = targets.filter(c => c.lat !== null && c.lng !== null)

      if (targetCoords.length > 0) {
        const lats = targetCoords.map(c => c.lat!)
        const lngs = targetCoords.map(c => c.lng!)

        if (targetCoords.length === 1) {
          const region = new mapkit.CoordinateRegion(
            new mapkit.Coordinate(lats[0], lngs[0]),
            new mapkit.CoordinateSpan(0.02, 0.02),
          )
          if (!initialFitDone.current) { map.region = region; initialFitDone.current = true }
          else map.setRegionAnimated(region, true)
        } else {
          const region = new mapkit.CoordinateRegion(
            new mapkit.Coordinate(
              (Math.max(...lats) + Math.min(...lats)) / 2,
              (Math.max(...lngs) + Math.min(...lngs)) / 2,
            ),
            new mapkit.CoordinateSpan(
              (Math.max(...lats) - Math.min(...lats)) * 1.4 + 0.01,
              (Math.max(...lngs) - Math.min(...lngs)) * 1.4 + 0.01,
            ),
          )
          if (!initialFitDone.current) { map.region = region; initialFitDone.current = true }
          else map.setRegionAnimated(region, true)
        }
      }
    }
  }, [mapReady, withCoords, placedClientIds, clientDayColorMap, offMonthClientIds, highlightedClientIds, emphasizedClientId, hasHighlight, highlightedClients, overlapMap, previewMoves, singleClientSelected, DAY_COLORS])

  // ── Track zoom (latitudeDelta) so badges can fade in/out ──
  useEffect(() => {
    if (!mapReady) return
    const map = mapRef.current
    if (!map) return

    const sync = () => {
      const span = map.region?.span
      if (span) setZoomDelta(span.latitudeDelta)
    }
    sync()
    map.addEventListener('region-change-end', sync)
    return () => { map.removeEventListener('region-change-end', sync) }
  }, [mapReady])

  // ── Apply badge opacity on every zoom change ──
  useEffect(() => {
    if (!mapReady) return
    const opacity = String(computeBadgeOpacity(zoomDelta))
    for (const entry of annotationMapRef.current.values()) {
      if (entry.badge) entry.badge.style.opacity = opacity
    }
  }, [zoomDelta, mapReady])

  // ── Home address pin ──
  useEffect(() => {
    if (!mapReady) return
    const map = mapRef.current
    if (!map) return

    // Remove old home pin
    if (homeAnnotationRef.current) {
      map.removeAnnotation(homeAnnotationRef.current)
      homeAnnotationRef.current = null
    }

    if (!homeAddress) return

    const coord = new mapkit.Coordinate(homeAddress.lat, homeAddress.lng)
    const annotation = new mapkit.Annotation(coord, () => {
      const el = document.createElement('div')
      el.style.cssText = `
        width: 28px; height: 28px; display: flex; align-items: center; justify-content: center;
        background: white; border-radius: 8px; border: 2px solid #374151;
        box-shadow: 0 1px 4px rgba(0,0,0,0.15); cursor: default;
      `
      el.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="#374151" xmlns="http://www.w3.org/2000/svg">
        <path d="M12 3L4 9v12h5v-7h6v7h5V9l-8-6z"/>
      </svg>`
      return el
    }, {
      anchorOffset: new DOMPoint(0, 0),
      enabled: false,
    })

    map.addAnnotation(annotation)
    homeAnnotationRef.current = annotation
  }, [mapReady, homeAddress])

  // ── Route polyline ──
  useEffect(() => {
    if (!mapReady) return
    const map = mapRef.current
    if (!map) return

    // Remove old route
    if (routeOverlayRef.current) {
      map.removeOverlay(routeOverlayRef.current)
      routeOverlayRef.current = null
    }

    if (!route || route.coordinates.length < 2) return

    const coords = route.coordinates.map(c => new mapkit.Coordinate(c.lat, c.lng))
    const polyline = new mapkit.PolylineOverlay(coords, {
      style: new mapkit.Style({
        lineWidth: 4,
        strokeColor: route.color,
        strokeOpacity: 0.8,
        lineCap: 'round',
        lineJoin: 'round',
      }),
    })

    map.addOverlay(polyline)
    routeOverlayRef.current = polyline
  }, [mapReady, route])

  return (
    <div className="h-full w-full relative">
      <div
        ref={containerRef}
        className="h-full w-full"
      />

      {!mapReady && (
        <div className="absolute inset-0 flex items-center justify-center z-[500] bg-gray-50">
          <div className="text-center">
            <div className="w-8 h-8 border-3 border-gray-200 border-t-gray-500 rounded-full animate-spin mx-auto mb-2" />
            <p className="text-xs text-gray-400">Loading map...</p>
          </div>
        </div>
      )}

      {selectedDateLabel && (
        <div className="absolute top-3 left-3 bg-white/90 backdrop-blur-sm rounded-lg px-3 py-1.5 shadow-sm border border-gray-200 z-[1000]">
          <div className="flex items-center gap-2">
            <div>
              <p className="text-xs font-semibold text-gray-700">
                {selectedDateLabel}
                {highlightedClients && (
                  <span className="text-gray-400 font-normal ml-1.5">
                    {highlightedClients.length} client{highlightedClients.length !== 1 ? 's' : ''}
                  </span>
                )}
              </p>
              {route && route.durationMinutes != null && (
                <p className="text-[10px] text-gray-500 mt-0.5">
                  {route.durationMinutes}m drive{route.distanceMiles != null && ` · ${route.distanceMiles} mi`}
                </p>
              )}
            </div>
            <button
              onClick={() => onPinClick?.('')}
              className="w-4 h-4 flex items-center justify-center rounded-full hover:bg-gray-200 text-gray-400 hover:text-gray-600 transition-colors shrink-0"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {withCoords.length === 0 && mapReady && (
        <div className="absolute inset-0 flex flex-col items-center justify-center z-[500] pointer-events-none">
          <div className="bg-white/80 backdrop-blur-sm rounded-xl px-6 py-4 text-center">
            <p className="text-sm font-medium text-gray-600">Add clients with addresses</p>
            <p className="text-xs text-gray-400 mt-0.5">Pins will appear here</p>
          </div>
        </div>
      )}
    </div>
  )
}

export default memo(ClientMap)
