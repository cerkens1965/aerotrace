/**
 * csvParser.js — Garmin G3X CSV parser for AeroTrace
 *
 * Format: 3 header rows + data at 1Hz
 *   Row 1: #airframe_info,...,aircraft_ident="FJFVB",...
 *   Row 2: Long column names
 *   Row 3: Short column names (used as keys)
 *   Row 4+: Data
 */

// Columns we extract from the G3X CSV
const COLS = {
  date:    'UTC Date',
  time:    'UTC Time',
  lat:     'Latitude',
  lon:     'Longitude',
  altGps:  'AltGPS',
  altInd:  'AltInd',
  altP:    'AltP',
  agl:     'AGL',
  gndSpd:  'GndSpd',
  ias:     'IAS',
  trk:     'TRK',      // GPS ground track — cap vrai sur le sol
  hdg:     'HDG',      // Cap magnétique — nécessite correction MagVar
  magVar:  'MagVar',   // Déclinaison magnétique (négatif = Ouest)
  vspd:    'VSpd',
  pitch:   'Pitch',
  roll:    'Roll',
  latAc:   'LatAc',
  normAc:  'NormAc',
  rpm:     'E1 RPM',
  oat:     'OAT',
  cht1:    'E1 CHT1',
  cht2:    'E1 CHT2',
  egt1:    'E1 EGT1',
  egt2:    'E1 EGT2',
  wndSpd:  'WndSpd',
  wndDir:  'WndDr',
}

/**
 * Parse airframe info from first row
 */
function parseAirframeInfo(line) {
  const info = {}
  const matches = line.matchAll(/(\w+(?:_\w+)*)="([^"]*)"/g)
  for (const m of matches) info[m[1]] = m[2]
  return info
}

/**
 * Parse a G3X CSV file content string
 * Returns: { airframe, columns, frames, stats }
 */
export function parseG3XCSV(content) {
  const lines = content.split('\n').filter(l => l.trim())

  if (lines.length < 4) throw new Error('Invalid G3X CSV: too few lines')

  // Row 1: airframe info
  const airframe = parseAirframeInfo(lines[0])

  // Row 3: short column names → build index map
  const shortHeaders = lines[2].split(',').map(h => h.trim())
  const colIndex = {}
  Object.entries(COLS).forEach(([key, colName]) => {
    const idx = shortHeaders.indexOf(colName)
    if (idx !== -1) colIndex[key] = idx
  })

  // Parse data rows
  const frames = []
  let minLat = Infinity, maxLat = -Infinity
  let minLon = Infinity, maxLon = -Infinity
  let maxAlt = -Infinity, maxSpd = -Infinity, maxG = -Infinity, maxRpm = -Infinity

  for (let i = 3; i < lines.length; i++) {
    const parts = lines[i].split(',')
    if (parts.length < 10) continue

    const get = (key) => {
      const idx = colIndex[key]
      return idx !== undefined ? parts[idx]?.trim() : null
    }
    const num = (key) => {
      const v = parseFloat(get(key))
      return isNaN(v) ? null : v
    }
    const numOr0 = (key) => num(key) ?? 0

    const dateStr = get('date')
    const timeStr = get('time')
    if (!dateStr || !timeStr) continue

    const ts = new Date(`${dateStr}T${timeStr}Z`).getTime()
    if (isNaN(ts)) continue

    const lat = num('lat')
    const lon = num('lon')
    if (lat === 0 && lon === 0) continue

    const frame = {
      ts,
      lat,
      lon,
      altGps:  num('altGps'),   // GPS altitude ft MSL — source la plus fiable en vol
      altInd:  num('altInd'),   // Baro altitude ft MSL (QNH)
      altP:    num('altP'),     // Pressure altitude ft
      agl:     num('agl'),      // AGL ft — souvent null en vol (G3X ne le publie pas toujours)
      gndSpd:  numOr0('gndSpd'),
      ias:     numOr0('ias'),
      trk:     num('trk'),      // GPS track vrai (null si GPS pas lock)
      hdg:     numOr0('hdg'),   // Cap magnétique
      magVar:  num('magVar'),   // Déclinaison magnétique (négatif = Ouest)
      vspd:    numOr0('vspd'),
      pitch:   numOr0('pitch'),
      roll:    numOr0('roll'),
      latAc:   numOr0('latAc'),
      normAc:  numOr0('normAc'),
      rpm:     numOr0('rpm'),
      oat:     numOr0('oat'),
      cht1:    numOr0('cht1'),
      cht2:    numOr0('cht2'),
      egt1:    numOr0('egt1'),
      egt2:    numOr0('egt2'),
      wndSpd:  numOr0('wndSpd'),
      wndDir:  numOr0('wndDir'),
    }

    // Cap vrai = cap magnétique + déclinaison
    // MagVar négatif = Ouest → True = Mag + MagVar (ex: HDG=26°, MagVar=-5° → True=21°)
    frame.truHdg = (frame.hdg + (frame.magVar ?? 0) + 360) % 360

    // Bearing caméra : TRK (GPS vrai) prioritaire, sinon cap vrai corrigé
    frame.bearing = (frame.trk !== null && frame.trk !== 0)
      ? frame.trk
      : frame.truHdg

    // Altitude MSL affichable (ft) : baro/indiquée (QNH) si dispo, SINON GPS. Les boîtiers
    // AT-CORE n'ont pas de capteur baro → AltInd=NaN ; il faut retomber sur AltGPS (déjà en
    // pieds), sinon ALT/maxAlt/altimètre/charts affichaient 0/NaN ou une valeur fausse.
    frame.alt = frame.altInd ?? frame.altGps

    // Vitesse affichable (kt) : IAS (pitot) si dispo, SINON vitesse sol GPS. Les boîtiers
    // AT-CORE n'ont pas de pitot → IAS=NaN (→0 via numOr0) ; il faut retomber sur GndSpd,
    // sinon l'indicateur de vitesse / la lecture IAS affichaient 0 (alt OK car déjà fallback).
    frame.spd = frame.ias || frame.gndSpd

    // Phase detection — utilise AGL si dispo, sinon vitesse sol comme proxy
    const aglFt = frame.agl ?? (frame.gndSpd < 5 ? 0 : null)
    if (frame.rpm < 800 || (aglFt !== null && aglFt < 50)) frame.phase = 'GROUND'
    else if (Math.abs(frame.normAc) > 2.5) frame.phase = 'CRITICAL'
    else if (aglFt !== null && aglFt < 500) frame.phase = 'APPROACH'
    else if (Math.abs(frame.roll) > 20) frame.phase = 'MANEUVER'
    else frame.phase = 'CRUISE'

    // Trail color based on G-load
    const g = Math.abs(frame.normAc)
    if (g > 2.5) frame.color = '#ef4444'      // Red flashing
    else if (g > 1.4) frame.color = '#eab308'  // Yellow
    else if (g > 1.2) frame.color = '#f97316'  // Orange
    else frame.color = '#22c55e'               // Green normal

    frames.push(frame)

    // Stats
    if (lat < minLat) minLat = lat
    if (lat > maxLat) maxLat = lat
    if (lon < minLon) minLon = lon
    if (lon > maxLon) maxLon = lon
    if (frame.alt > maxAlt) maxAlt = frame.alt
    if (frame.spd > maxSpd)    maxSpd = frame.spd
    if (g > maxG)              maxG = g
    if (frame.rpm > maxRpm)    maxRpm = frame.rpm
  }

  if (frames.length === 0) throw new Error('No valid frames found in CSV')

  const duration = Math.round((frames[frames.length - 1].ts - frames[0].ts) / 1000)

  return {
    airframe,
    frames,
    stats: {
      frameCount: frames.length,
      duration,        // seconds
      durationHuman: `${Math.floor(duration/3600)}h${String(Math.floor((duration%3600)/60)).padStart(2,'0')}`,
      startTs: frames[0].ts,
      endTs:   frames[frames.length - 1].ts,
      bounds:  { minLat, maxLat, minLon, maxLon },
      maxAlt:  Math.round(maxAlt),
      maxSpd:  Math.round(maxSpd),
      maxG:    Math.round(maxG * 10) / 10,
      maxRpm:  Math.round(maxRpm),
    }
  }
}

/**
 * Subsample frames for map rendering (max N points)
 */
export function subsampleFrames(frames, maxPoints = 2000) {
  if (frames.length <= maxPoints) return frames
  const step = Math.ceil(frames.length / maxPoints)
  return frames.filter((_, i) => i % step === 0)
}

/**
 * Get frame at a specific time (binary search)
 */
export function getFrameAtTime(frames, ts) {
  let lo = 0, hi = frames.length - 1
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (frames[mid].ts < ts) lo = mid + 1
    else hi = mid
  }
  return frames[lo]
}
