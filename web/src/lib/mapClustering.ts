/**
 * Map Clustering Helpers — platform-agnostic.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  PORTABILITY NOTE
 * ─────────────────────────────────────────────────────────────────────────
 *  This module is pure TypeScript with zero framework dependencies (no React,
 *  no react-native-maps, no Leaflet, no Google Maps). The same file can be
 *  copy-pasted into pip-web's `src/utils/` and imported unchanged.
 *
 *  When porting to web:
 *    1. Copy this file verbatim into `pip-web/web/src/utils/mapClustering.ts`.
 *    2. Replace the existing `applyOverlapOffsets` in `ClientMap.tsx` with
 *       `computeOverlapMap` + `fanOutCoord` from this module.
 *    3. On web, `zoomDelta` (latitudeDelta) is `bounds.getNorth() - bounds.getSouth()`
 *       for Leaflet, or `bounds.getNorthEast().lat() - bounds.getSouthWest().lat()`
 *       for Google. Same units (degrees), same thresholds.
 *
 *  ─────────────────────────────────────────────────────────────────────────
 *  WHAT'S IN HERE
 *  ─────────────────────────────────────────────────────────────────────────
 *  - `computeOverlapMap`: O(n) hash-bucket detection. Stops in the same
 *    ~110m grid cell are clustered. Returns each stop's count + index.
 *  - `fanOutCoord`: given a stop's true coord + cluster info, return an
 *    offset coord on a ~30m circle around the stop's OWN position (not the
 *    cluster centroid — preserves real-world position accuracy).
 *  - `computeBadgeOpacity`: piecewise-linear fade based on zoom level.
 *    Badge fully shown when zoomed out, hidden when zoomed in, smooth fade
 *    in between.
 *  - `isBadgeFading`: convenience for `tracksViewChanges` perf optimization.
 *
 *  ─────────────────────────────────────────────────────────────────────────
 *  WHY THIS DESIGN (vs. the web's current applyOverlapOffsets)
 *  ─────────────────────────────────────────────────────────────────────────
 *  - **O(n) instead of O(n²)** — scales to 500+ pins without lag.
 *  - **Fan-out around each pin's own coord, not cluster centroid** — pins
 *    move at most ~30m from their true location, so map positions stay
 *    trustworthy. (Web's centroid approach can shift pins ~50m+ from truth.)
 *  - **Count badge with zoom-aware fade** — the count signal is the primary
 *    UX. Fan-out is just a courtesy at intermediate zoom.
 */

// ── Types ───────────────────────────────────────────────────────────────────

export interface OverlapInfo {
  /** Total stops in this cluster, including self. 1 means no overlap. */
  count: number;
  /** 0-based position of this stop within its cluster. Used for fan angle. */
  index: number;
}

export interface LatLng {
  latitude: number;
  longitude: number;
}

// ── Constants ───────────────────────────────────────────────────────────────

/** Fan-out radius in degrees (~30m at the equator). Matches web's spread. */
export const FAN_OUT_RADIUS = 0.0003;

/** Badge fully visible above this zoomDelta (latitudeDelta degrees). */
export const BADGE_FADE_IN = 0.035;

/** Badge fully hidden below this zoomDelta. */
export const BADGE_FADE_OUT = 0.008;

// ── Bucketing (cluster detection) ───────────────────────────────────────────

/** ~110m grid bucket key. Stops in the same bucket are considered overlapping. */
function bucketKey(lat: number, lng: number): string {
  return `${Math.round(lat * 1000)},${Math.round(lng * 1000)}`;
}

/**
 * O(n) overlap detection — group stops by ~110m grid cells.
 *
 * Generic over stop shape: pass accessor functions for id/lat/lng so any
 * domain object (mobile's `ClientPlacement`, web's `Client`, etc.) works
 * without conversion.
 *
 * @returns map of stopId → { count, index }
 */
export function computeOverlapMap<T>(
  stops: readonly T[],
  getId: (s: T) => string,
  getLat: (s: T) => number,
  getLng: (s: T) => number,
): Record<string, OverlapInfo> {
  const counts: Record<string, number> = {};
  const bucketIds: Record<string, string[]> = {};

  for (const s of stops) {
    const key = bucketKey(getLat(s), getLng(s));
    counts[key] = (counts[key] || 0) + 1;
    if (!bucketIds[key]) bucketIds[key] = [];
    bucketIds[key].push(getId(s));
  }

  const result: Record<string, OverlapInfo> = {};
  for (const s of stops) {
    const id = getId(s);
    const key = bucketKey(getLat(s), getLng(s));
    result[id] = {
      count: counts[key],
      index: bucketIds[key].indexOf(id),
    };
  }
  return result;
}

// ── Fan-out (visual separation for stacked pins) ────────────────────────────

/**
 * Given a stop's true coord + its overlap info, return the offset coord for
 * rendering. Stops with no overlap (count <= 1) pass through unchanged.
 *
 * Fan layout: pins are placed evenly on a circle of `radius` degrees around
 * the stop's OWN coord, starting at 12 o'clock (-π/2). A 4-pin stack forms
 * a "+" pattern, 6 a hexagon, etc.
 */
export function fanOutCoord(
  lat: number,
  lng: number,
  overlap: OverlapInfo,
  radius: number = FAN_OUT_RADIUS,
): LatLng {
  if (overlap.count <= 1) {
    return { latitude: lat, longitude: lng };
  }
  const angle = (overlap.index / overlap.count) * 2 * Math.PI - Math.PI / 2;
  return {
    latitude: lat + Math.cos(angle) * radius,
    longitude: lng + Math.sin(angle) * radius,
  };
}

// ── Badge opacity (zoom-aware fade) ─────────────────────────────────────────

/**
 * Piecewise-linear opacity for the cluster-count badge based on zoom level.
 *
 * `zoomDelta` is the map's `latitudeDelta` — the latitude span (in degrees)
 * currently visible. Larger = zoomed out.
 *
 *  zoomDelta >= BADGE_FADE_IN  → 1 (fully visible — pins look stacked)
 *  zoomDelta <= BADGE_FADE_OUT → 0 (hidden — fan-out is doing the work)
 *  in between                  → linear fade
 *
 * Why fade? At intermediate zoom the fan-out (~30m) is starting to be visually
 * resolvable. Cross-fading the badge avoids a hard pop when the user pinches.
 */
export function computeBadgeOpacity(zoomDelta: number): number {
  if (zoomDelta >= BADGE_FADE_IN) return 1;
  if (zoomDelta <= BADGE_FADE_OUT) return 0;
  return (zoomDelta - BADGE_FADE_OUT) / (BADGE_FADE_IN - BADGE_FADE_OUT);
}

/**
 * True iff `zoomDelta` is in the fade-active range. On mobile, pass this to
 * `<Marker tracksViewChanges>` so the marker view only re-renders during the
 * fade transition (perf optimization). Outside the fade range, the badge is
 * static (fully on or fully off) — no need to track view changes.
 */
export function isBadgeFading(zoomDelta: number): boolean {
  return zoomDelta > BADGE_FADE_OUT && zoomDelta < BADGE_FADE_IN;
}
