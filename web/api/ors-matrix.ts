import type { VercelRequest, VercelResponse } from '@vercel/node'

const ORS_BASE_URL = 'https://api.openrouteservice.org'
const ORS_API_KEY = process.env.ORS_API_KEY

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  if (!ORS_API_KEY) {
    return res.status(500).json({ error: 'ORS API key not configured' })
  }

  try {
    const { locations, sources } = req.body

    if (!locations || !Array.isArray(locations) || locations.length < 2) {
      return res.status(400).json({ error: 'Need at least 2 locations' })
    }

    const payload: Record<string, unknown> = { locations, metrics: ['duration'] }
    if (Array.isArray(sources) && sources.length > 0) payload.sources = sources

    const response = await fetch(`${ORS_BASE_URL}/v2/matrix/driving-car`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': ORS_API_KEY,
      },
      body: JSON.stringify(payload),
    })

    if (!response.ok) {
      const body = await response.text()
      return res.status(response.status).json({ error: `ORS error: ${body}` })
    }

    const data = await response.json()
    return res.status(200).json(data)
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'ORS request failed' })
  }
}
