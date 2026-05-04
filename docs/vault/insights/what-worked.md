---
tags: [insights, lessons]
updated: 2026-04-08
---

# What Worked

## Google Places over ORS for geocoding
ORS free tier can't reliably geocode US addresses. Google Places Autocomplete guarantees lat/lng from the user's selection. Keep ORS for bulk import fallback only.

## Roster fingerprint for VROOM caching
Simple but effective — hash client IDs + coordinates, cache VROOM results against it. Eliminates non-determinism without removing the ability to re-optimize when the roster actually changes.

## Cap swaps per client
One geographically central client was appearing in 30+ swaps, making the list unusable. Capping at 3 per client (sorted by savings) made the suggestions actionable.

## Independent move validation
VROOM's suggestions aren't always safe individually. Validating each move independently against the current schedule prevents cascading failures when a client says "no."

# What Didn't Work

## ORS GeoJSON directions endpoint
POST to `/v2/directions/driving-car/geojson` returns "format not supported." Had to use the regular JSON endpoint and decode the polyline server-side.

## Controlled React inputs + Google Autocomplete
Minor tension between React controlling input value and Google's widget setting it directly. Works in practice but the place_changed handler needs to sync state immediately.

## `store` as useEffect dependency
Putting the store context object in a useEffect dependency array causes the effect to fire every render (context value changes reference each render). Use specific values or suppress the lint rule.
