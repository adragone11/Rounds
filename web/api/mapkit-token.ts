import type { VercelRequest, VercelResponse } from '@vercel/node'

const TEAM_ID = '2L4J8KLTK2'
const KEY_ID = 'YLV5G3RL68'
const PRIVATE_KEY = process.env.MAPKIT_PRIVATE_KEY
const ALLOWED_ORIGINS = process.env.MAPKIT_ALLOWED_ORIGINS

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    return res.status(200).end()
  }

  // Only allow GET
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  if (!PRIVATE_KEY) {
    return res.status(500).json({ error: 'MAPKIT_PRIVATE_KEY not configured' })
  }

  try {
    // Dynamic import for jose (ESM-only package)
    const { SignJWT, importPKCS8 } = await import('jose')

    // Format the key with proper PEM headers
    const pem = `-----BEGIN PRIVATE KEY-----\n${PRIVATE_KEY}\n-----END PRIVATE KEY-----`
    const key = await importPKCS8(pem, 'ES256')

    const origins = ALLOWED_ORIGINS
      ? ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
      : (req.headers.origin ? [req.headers.origin as string] : [])

    const payload: Record<string, unknown> = {}
    if (origins.length) payload.origin = origins.join(' ')

    const token = await new SignJWT(payload)
      .setProtectedHeader({ alg: 'ES256', kid: KEY_ID, typ: 'JWT' })
      .setIssuer(TEAM_ID)
      .setIssuedAt()
      .setExpirationTime('1h')
      .setAudience('https://maps.apple.com')
      .sign(key)

    // Cache for 50 minutes (token valid for 60)
    res.setHeader('Cache-Control', 's-maxage=3000, stale-while-revalidate=600')
    res.setHeader('Access-Control-Allow-Origin', '*')
    return res.status(200).json({ token })
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Token generation failed' })
  }
}
