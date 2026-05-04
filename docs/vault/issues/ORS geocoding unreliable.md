---
tags: [bug, geocoding, fixed]
severity: critical
fixed: 2026-04-08
---

# ORS Geocoding Unreliable

## Problem
OpenRouteService geocoding silently fails for many addresses. Clients end up with `lat: null, lng: null` — invisible on map, excluded from route optimization. No error shown to user.

## Root Cause
ORS free tier has limited geocoding accuracy for US addresses. Many valid addresses return no results. The `geocode()` function in `store.tsx` silently returns `null` on failure.

## Fix
Replaced all address inputs with **Google Places Autocomplete**. Addresses selected from Google come with guaranteed lat/lng. ORS kept as fallback for bulk import only.

## Files Changed
- `src/components/AddressAutocomplete.tsx` (new)
- `src/store.tsx` — accept optional pre-geocoded coords
- `src/pages/Clients.tsx` — use AddressAutocomplete
- `src/pages/Schedule.tsx` — use AddressAutocomplete in all address inputs
