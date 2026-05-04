import type { VercelRequest, VercelResponse } from '@vercel/node'

const ORS_BASE_URL = 'https://api.openrouteservice.org'
const ORS_API_KEY = process.env.ORS_API_KEY

/** Decode Google-style encoded polyline to [lat, lng] pairs */
function decodePolyline(encoded: string): Array<{ lat: number; lng: number }> {
  const points: Array<{ lat: number; lng: number }> = []
  let index = 0, lat = 0, lng = 0

  while (index < encoded.length) {
    let shift = 0, result = 0, byte: number
    do {
      byte = encoded.charCodeAt(index++) - 63
      result |= (byte & 0x1f) << shift
      shift += 5
    } while (byte >= 0x20)
    lat += (result & 1) ? ~(result >> 1) : (result >> 1)

    shift = 0; result = 0
    do {
      byte = encoded.charCodeAt(index++) - 63
      result |= (byte & 0x1f) << shift
      shift += 5
    } while (byte >= 0x20)
    lng += (result & 1) ? ~(result >> 1) : (result >> 1)

    points.push({ lat: lat / 1e5, lng: lng / 1e5 })
  }
  return points
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  if (!ORS_API_KEY) {
    return res.status(500).json({ error: 'ORS API key not configured' })
  }

  try {
    const { coordinates } = req.body

    if (!coordinates || !Array.isArray(coordinates) || coordinates.length < 2) {
      return res.status(400).json({ error: 'Need at least 2 coordinates ([[lng,lat], ...])' })
    }

    const response = await fetch(`${ORS_BASE_URL}/v2/directions/driving-car`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json, application/geo+json, application/gpx+xml, img/png; charset=utf-8',
        'Content-Type': 'application/json',
        'Authorization': ORS_API_KEY,
      },
      body: JSON.stringify({ coordinates }),
    })

    if (!response.ok) {
      const body = await response.text()
      return res.status(response.status).json({ error: `ORS error: ${body}` })
    }

    const data = await response.json()

    const route = data.routes?.[0]
    if (!route?.geometry) {
      return res.status(200).json({ coordinates: [] })
    }

    // Decode the encoded polyline
    const routeCoords = decodePolyline(route.geometry)

    const summary = route.summary
    return res.status(200).json({
      coordinates: routeCoords,
      durationMinutes: summary ? Math.round(summary.duration / 60) : null,
      distanceMiles: summary ? Math.round(summary.distance / 1609.34 * 10) / 10 : null,
    })
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Directions request failed' })
  }
}
