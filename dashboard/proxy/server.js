const express = require('express')
const cors = require('cors')
const dotenv = require('dotenv')
const crypto = require('crypto')

dotenv.config()

const app = express()
const PORT = 3001
const SAFESKY_KEY = process.env.SAFESKY_KEY

if (!SAFESKY_KEY) {
  console.error('SAFESKY_KEY manquant dans .env')
  process.exit(1)
}

app.use(cors())
app.use(express.json())

// ── HMAC Auth SafeSky ──────────────────────────────────────
function deriveKid(apiKey) {
  const hash = crypto.createHash('sha256').update('kid:' + apiKey).digest()
  return hash.slice(0, 16).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function deriveHmacKey(apiKey) {
  const salt = Buffer.from('safesky-hmac-salt-v1', 'utf8')
  const info = Buffer.from('auth-v1', 'utf8')
  const prk = crypto.createHmac('sha256', salt).update(Buffer.from(apiKey, 'utf8')).digest()
  const t = crypto.createHmac('sha256', prk).update(Buffer.concat([info, Buffer.from([1])])).digest()
  return t.slice(0, 32)
}

function generateNonce() {
  return crypto.randomUUID()
}

function generateTimestamp() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function buildCanonicalRequest(method, path, queryString, host, timestamp, nonce, body) {
  const bodyHash = crypto.createHash('sha256').update(body || '').digest('hex')
  return [
    method.toUpperCase(),
    path,
    queryString,
    `host:${host}`,
    `x-ss-date:${timestamp}`,
    `x-ss-nonce:${nonce}`,
    '',
    bodyHash
  ].join('\n')
}

function generateAuthHeaders(apiKey, method, url, body = '') {
  const parsed = new URL(url)
  const host = parsed.host
  const path = parsed.pathname
  const queryString = parsed.search ? parsed.search.slice(1) : ''
  const timestamp = generateTimestamp()
  const nonce = generateNonce()
  const kid = deriveKid(apiKey)
  const hmacKey = deriveHmacKey(apiKey)
  const canonical = buildCanonicalRequest(method, path, queryString, host, timestamp, nonce, body)
  const signature = crypto.createHmac('sha256', hmacKey).update(canonical).digest('base64')

  return {
    'Authorization': `SS-HMAC Credential=${kid}/v1, SignedHeaders=host;x-ss-date;x-ss-nonce, Signature=${signature}`,
    'X-SS-Date': timestamp,
    'X-SS-Nonce': nonce,
    'X-SS-Alg': 'SS-HMAC-SHA256-V1',
    'Content-Type': 'application/json',
  }
}
// ──────────────────────────────────────────────────────────

app.get('/safesky/traffic', async (req, res) => {
  const { lat_min, lat_max, lon_min, lon_max } = req.query
  if (!lat_min || !lat_max || !lon_min || !lon_max) {
    return res.status(400).json({ error: 'Missing bounds params' })
  }
  // Centre de la bounding box pour le POST SafeSky
  const lat = ((parseFloat(lat_min) + parseFloat(lat_max)) / 2).toFixed(4)
  const lon = ((parseFloat(lon_min) + parseFloat(lon_max)) / 2).toFixed(4)

  try {
    const { default: fetch } = await import('node-fetch')

    const url = 'https://uav-api.safesky.app/v1/uav?return_nearby_traffic=true&show_grounded=true'
    const body = JSON.stringify([{
      id: 'aerotrace-dashboard',
      latitude: parseFloat(lat),
      longitude: parseFloat(lon),
      altitude: 300,
      last_update: Math.floor(Date.now() / 1000),
    }])
    const headers = generateAuthHeaders(SAFESKY_KEY, 'POST', url, body)

    const response = await fetch(url, { method: 'POST', headers, body })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`SafeSky ${response.status} — ${text}`)
    }

    const data = await response.json()
    const traffic = Array.isArray(data) ? data : (data.nearby_traffic ?? [])
    res.json({ nearby_traffic: traffic })

  } catch (error) {
    console.error('SafeSky error:', error)
    res.status(500).json({ error: error.message })
  }
})

app.listen(PORT, () => {
  console.log(`SafeSky proxy running on http://localhost:${PORT}`)
})