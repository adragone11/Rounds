import type { VercelRequest, VercelResponse } from '@vercel/node'

const ORS_API_KEY = process.env.ORS_API_KEY

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const q = req.query.q as string
  if (!q) {
    return res.status(400).json({ error: 'Missing q parameter' })
  }

  if (!ORS_API_KEY) {
    return res.status(500).json({ error: 'ORS API key not configured' })
  }

  try {
    const response = await fetch(
      `https://api.openrouteservice.org/geocode/search?api_key=${ORS_API_KEY}&text=${encodeURIComponent(q)}&size=1&boundary.country=US`,
      { headers: { 'Accept': 'application/json' } }
    )

    if (!response.ok) {
      const body = await response.text()
      return res.status(response.status).json({ error: `ORS geocode error: ${body}` })
    }

    const data = await response.json()
    const feature = data.features?.[0]

    if (feature?.geometry?.coordinates) {
      const [lng, lat] = feature.geometry.coordinates
      return res.status(200).json({ lat, lng })
    }

    return res.status(200).json({ lat: null, lng: null })
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Geocode failed' })
  }
}
