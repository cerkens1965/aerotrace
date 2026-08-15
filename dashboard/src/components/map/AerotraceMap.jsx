import { useEffect, useRef, useState, useCallback } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { collection, getDocs, query, where } from 'firebase/firestore'
import { db } from '../../firebase/config'
import useSafeSky from '../../hooks/useSafeSky'
import { useClub } from '../../contexts/ClubContext'

const MAPTILER_KEY = import.meta.env.VITE_MAPTILER_KEY
const OPENAIP_KEY = import.meta.env.VITE_OPENAIP_KEY
const CENTER = { lat: 50.6083, lon: 4.4650 } // EBBY
const ALT_MAX = 35000

// Sémantique couleur carte (demande Christophe 2026-08-14) :
//   FLOTTE EBBY (émet via ATC/AeroTrace, owner OU club) = ROUGE #ef4444
//   TRAFIC SafeSky ambiant (tout le reste)              = BLEU VIF #1e90ff
// CSS filter: black SVG → red #ef4444
const FLEET_FILTER   = 'brightness(0) saturate(100%) invert(27%) sepia(94%) saturate(1832%) hue-rotate(337deg) brightness(103%)'
// black SVG → bleu vif (dodger) #1e90ff
const SAFESKY_FILTER = 'brightness(0) saturate(100%) invert(39%) sepia(57%) saturate(2618%) hue-rotate(196deg) brightness(101%) contrast(101%)'
const FLEET_CLR   = '#ef4444'
const SAFESKY_CLR = '#1e90ff'

// Icône par type d'aéronef — reprend le set + la sémantique de l'écran ATV radar
// (firmware getAircraftIcon / safeSkyUDPToIcon). SafeSky REST donne le TYPE dans
// `beacon_type` (STRING : JET, MOTORPLANE, HELICOPTER, UAV, GLIDER…) ; on le mappe
// vers les mêmes SVG que le radar (public/icons/, monochromes recolorables au filter).
const BEACON_ICON = {
  GLIDER: 'glider', MOTOR_GLIDER: 'glider', SAILPLANE: 'glider',
  TOW_PLANE: 'light_aircraft', DROP_PLANE: 'light_aircraft',
  HELICOPTER: 'helicopter', ROTORCRAFT: 'helicopter',
  PARACHUTE: 'parachute', SKYDIVER: 'parachute',
  HANG_GLIDER: 'hand_glider', HANGGLIDER: 'hand_glider',
  PARA_GLIDER: 'para_glider', PARAGLIDER: 'para_glider',
  MOTORPLANE: 'light_aircraft', POWERED_AIRCRAFT: 'light_aircraft', ULTRALIGHT: 'light_aircraft',
  JET: 'heavy_aircraft',
  BALLOON: 'ballon', AIRSHIP: 'airship',
  UAV: 'uav', DRONE: 'uav',
  GYROCOPTER: 'gyrocopter',
  STATIC_OBJECT: 'dot',
  UNKNOWN: 'aircraft',
}
const iconForBeacon = (bt) => BEACON_ICON[(bt || '').toUpperCase()] || 'aircraft'

const BASEMAPS = [
  { id: 'dataviz-light', label: 'Light' },
  { id: 'dataviz-dark',  label: 'Dark' },
  { id: 'outdoor-v2',    label: 'Topo' },
  { id: 'satellite',     label: 'Satellite' },
  { id: 'basic-v2',      label: 'Basic' },
]

const AIRPORT_TYPES = [
  { id: 'fixed', label: 'ADEP / ULM / MIL' },
  { id: 'heli',  label: 'HÉLIPAD' },
  { id: 'sea',   label: 'HYDRAVION' },
]

const LAYERS = [
  { id: 'ctr',      label: 'CTR',      color: '#dc3232', rgb: '220,50,50',  hasSlider: true,  hasAltSlider: false },
  { id: 'tma',      label: 'TMA/CTA',  color: '#1e64dc', rgb: '30,100,220', hasSlider: true,  hasAltSlider: false },
  { id: 'danger',   label: 'DANGER',   color: '#ff8c00', rgb: '255,140,0',  hasSlider: true,  hasAltSlider: false },
  { id: 'airports', label: 'AIRPORTS', color: '#4a7ab5', rgb: '74,122,181', hasSlider: false, hasAltSlider: false },
  { id: 'traffic',  label: 'TRAFFIC',  color: '#00cc66', rgb: '0,204,102',  hasSlider: false, hasAltSlider: true  },
]

const LAYER_IDS = {
  ctr:      ['airspace-ctr-fill', 'airspace-ctr-line'],
  tma:      ['airspace-tma-fill', 'airspace-tma-line'],
  danger:   ['airspace-danger-fill', 'airspace-danger-line'],
  airports: ['airports', 'airports-labels'],
}

const FILL_COLORS = {
  ctr:    (o) => `rgba(220,50,50,${o})`,
  tma:    (o) => `rgba(30,100,220,${o})`,
  danger: (o) => `rgba(255,140,0,${o})`,
}

function formatAlt(ft) {
  if (ft <= 0) return 'GND'
  if (ft >= ALT_MAX) return 'FL350+'
  return `FL${String(Math.round(ft / 100)).padStart(3, '0')}`
}

function getAirportFilter(active) {
  if (!active.length) return ['==', 'type', 'NONE']
  const parts = []
  if (active.includes('fixed')) parts.push(['in', ['get', 'type'], ['literal', ['apt', 'af_civil', 'ad_mil', 'light_aircraft']]])
  if (active.includes('heli'))  parts.push(['==', ['get', 'type'], 'heli_civil'])
  if (active.includes('sea'))   parts.push(['==', ['get', 'type'], 'af_water'])
  return parts.length === 1 ? parts[0] : ['any', ...parts]
}

function addOpenAIPLayers(map, activeAirportTypes) {
  if (map.getSource('openaip')) return
  map.addSource('openaip', {
    type: 'vector',
    tiles: [`https://api.tiles.openaip.net/api/data/openaip/{z}/{x}/{y}.pbf?apiKey=${OPENAIP_KEY}`],
    minzoom: 0, maxzoom: 14,
  })
  map.addLayer({ id: 'airspace-ctr-fill', type: 'fill', source: 'openaip', 'source-layer': 'airspaces', filter: ['==', ['get', 'type'], 'ctr'], paint: { 'fill-color': 'rgba(220,50,50,0.03)' } })
  map.addLayer({ id: 'airspace-ctr-line', type: 'line', source: 'openaip', 'source-layer': 'airspaces', filter: ['==', ['get', 'type'], 'ctr'], paint: { 'line-color': 'rgba(220,50,50,0.9)', 'line-width': 2, 'line-dasharray': [4, 2] } })
  map.addLayer({ id: 'airspace-tma-fill', type: 'fill', source: 'openaip', 'source-layer': 'airspaces', filter: ['in', ['get', 'type'], ['literal', ['tma', 'cta']]], paint: { 'fill-color': 'rgba(0,0,0,0)' } })
  map.addLayer({ id: 'airspace-tma-line', type: 'line', source: 'openaip', 'source-layer': 'airspaces', filter: ['in', ['get', 'type'], ['literal', ['tma', 'cta']]], paint: { 'line-color': 'rgba(30,100,220,0.85)', 'line-width': 1.5 } })
  map.addLayer({ id: 'airspace-danger-fill', type: 'fill', source: 'openaip', 'source-layer': 'airspaces', filter: ['in', ['get', 'type'], ['literal', ['danger', 'restricted', 'prohibited']]], paint: { 'fill-color': 'rgba(0,0,0,0)' } })
  map.addLayer({ id: 'airspace-danger-line', type: 'line', source: 'openaip', 'source-layer': 'airspaces', filter: ['in', ['get', 'type'], ['literal', ['danger', 'restricted', 'prohibited']]], paint: { 'line-color': 'rgba(255,140,0,0.9)', 'line-width': 1.5, 'line-dasharray': [3, 2] } })

  map.addLayer({ id: 'airports', type: 'circle', source: 'openaip', 'source-layer': 'airports', paint: { 'circle-radius': 5, 'circle-color': '#1a3a6b', 'circle-stroke-width': 2, 'circle-stroke-color': '#ffffff' } })
  map.addLayer({ id: 'airports-labels', type: 'symbol', source: 'openaip', 'source-layer': 'airports', layout: { 'text-field': ['get', 'icao_code'], 'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'], 'text-size': 10, 'text-offset': [0, 1.4], 'text-anchor': 'top' }, paint: { 'text-color': '#1a3a6b', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 } })
  const f = getAirportFilter(activeAirportTypes)
  map.setFilter('airports', f)
  map.setFilter('airports-labels', f)
}

function SliderTrack({ value, max = 30, color, onChange }) {
  return (
    <div style={{ position: 'relative', height: 10, display: 'flex', alignItems: 'center' }}>
      <div style={{ position: 'absolute', width: '100%', height: 1, background: 'rgba(255,255,255,0.08)', borderRadius: 1 }} />
      <div style={{ position: 'absolute', width: `${(value / max) * 100}%`, height: 1, background: color, borderRadius: 1 }} />
      <div style={{ position: 'absolute', left: `calc(${(value / max) * 100}% - 4px)`, width: 8, height: 8, borderRadius: '50%', background: color, pointerEvents: 'none' }} />
      <input type="range" min={0} max={max} step={max === ALT_MAX ? 1000 : 1} value={value}
        onChange={e => onChange(Number(e.target.value))}
        style={{ position: 'absolute', width: '100%', opacity: 0, cursor: 'pointer', height: 10, margin: 0, background: 'transparent', WebkitAppearance: 'none', appearance: 'none' }} />
    </div>
  )
}

export default function AerotraceMap({ flyTo = null }) {
  const { clubId } = useClub()
  const mapContainer = useRef(null)
  const map = useRef(null)
  const markersRef = useRef({})
  const [mapBounds, setMapBounds] = useState(null)
  const traffic = useSafeSky(mapBounds)
  const [fleetOwn, setFleetOwn] = useState(new Map())   // icao24(hex) -> 'club' | 'owner' (flotte du club courant)
  const [fleetRole, setFleetRole] = useState(new Map())  // callSign -> 'club' | 'owner' (balises AeroTrace)
  const [fleetBcn, setFleetBcn]   = useState({})         // callSign -> balise FlyADSL (avions HORS flux radar)
  const drRef = useRef({})                               // dead-reckoning par cible (anticipation cap/vitesse)
  // Fond de carte : persisté (localStorage) — sans ça, chaque changement de page
  // démontait le composant et revenait au fond standard (demande Christophe 01/08).
  const [activeBasemap, setActiveBasemap] = useState(() => {
    const saved = localStorage.getItem('at_basemap')
    return BASEMAPS.some(b => b.id === saved) ? saved : 'dataviz-light'
  })
  useEffect(() => { localStorage.setItem('at_basemap', activeBasemap) }, [activeBasemap])
  const [visible, setVisible] = useState({ ctr: true, tma: true, danger: true, airports: true, traffic: true })
  const [opacity, setOpacity] = useState({ ctr: 3, tma: 0, danger: 0 })
  const [activeAirports, setActiveAirports] = useState(['fixed'])
  const [altRange, setAltRange] = useState([0, ALT_MAX])
  const [panelOpen, setPanelOpen] = useState({ layers: true, map: false })
  const [mapReady, setMapReady] = useState(false)

  useEffect(() => {
    if (!flyTo || !map.current || !mapReady) return
    map.current.flyTo({ center: [flyTo.lon, flyTo.lat], zoom: flyTo.zoom ?? 13, duration: 1200 })
  }, [flyTo, mapReady])

  // Flotte du club courant (highlight carte) : club = ROUGE, propriétaire = BLEU.
  // Filtré par clubId pour que super_admin voie la flotte du club sélectionné.
  useEffect(() => {
    if (!clubId) { setFleetOwn(new Map()); return }
    const q = query(collection(db, 'aircraft'), where('clubId', '==', clubId))
    getDocs(q)
      .then(snap => {
        const m = new Map(); const roles = new Map()
        snap.forEach(doc => {
          const d = doc.data()
          if (d.archived) return                                  // (T18) archivés hors vues live
          if (d.icao24)   m.set(d.icao24.toUpperCase(), d.ownership === 'owner' ? 'owner' : 'club')
          if (d.callSign) roles.set(d.callSign.toUpperCase(), d.ownership === 'owner' ? 'owner' : 'club')
        })
        setFleetOwn(m); setFleetRole(roles)
      })
      .catch(err => console.error('[AerotraceMap] aircraft load:', err))
  }, [clubId])

  const filteredTraffic = traffic.filter(ac => {
    const alt = ac.altitude || 0
    return alt >= altRange[0] && alt <= altRange[1]
  })

  // (2026-08-11) BALISES AeroTrace sur la carte : un FK9 SANS transpondeur n'existe pas dans le
  // flux radar uav-api → on interroge FlyADSL par callsign (comme la page En vol, poll 5 s) et on
  // l'affiche en marqueur dédié (dédupliqué si le radar voit déjà ce callsign).
  useEffect(() => {
    const signs = [...fleetRole.keys()]
    if (!signs.length) { setFleetBcn({}); return }
    let stop = false
    const poll = async () => {
      try {
        const res = await fetch(`/safesky/fleet?call_signs=${signs.join(',')}`)
        if (res.ok) { const d = await res.json(); if (!stop) setFleetBcn(d.beacons ?? {}) }
      } catch { /* best-effort */ }
    }
    poll()
    const t = setInterval(poll, 5000)
    return () => { stop = true; clearInterval(t) }
  }, [fleetRole])

  const radarSigns = new Set(filteredTraffic.map(a => (a.call_sign || '').toUpperCase()).filter(Boolean))
  const beaconTargets = Object.values(fleetBcn ?? {}).filter(b => {
    if (!b || b.latitude == null) return false
    const fresh = (Date.now() / 1000 - (b.timestamp ?? 0)) < 180
    return fresh && !radarSigns.has((b.call_sign || '').toUpperCase())
  }).map(b => ({
    id: `BCN_${b.call_sign}`,
    call_sign: b.call_sign,
    latitude: b.latitude, longitude: b.longitude,
    altitude: b.altitude != null ? Math.round(b.altitude * 3.28084) : 0,   // m → ft (FlyADSL = SI)
    ground_speed: b.ground_speed != null ? b.ground_speed * 1.94384 : 0,   // m/s → kt
    course: b.ground_track ?? 0,
    beacon_type: 'MOTORPLANE', status: b.flight_state ?? '',
    _fleetBeacon: true,
  })).filter(a => (a.altitude || 0) >= altRange[0] && (a.altitude || 0) <= altRange[1])
  const allTargets = [...filteredTraffic, ...beaconTargets]

  const toggleLayer = (id) => {
    const next = { ...visible, [id]: !visible[id] }
    setVisible(next)
    if (!map.current || id === 'traffic') return
    ;(LAYER_IDS[id] || []).forEach(lid => {
      if (map.current.getLayer(lid))
        map.current.setLayoutProperty(lid, 'visibility', next[id] ? 'visible' : 'none')
    })
  }

  const handleOpacity = (id, val) => {
    setOpacity(prev => ({ ...prev, [id]: val }))
    const fillLayerId = `airspace-${id}-fill`
    if (map.current?.getLayer(fillLayerId))
      map.current.setPaintProperty(fillLayerId, 'fill-color', FILL_COLORS[id](val / 100))
  }

  const toggleAirportType = (typeId) => {
    const next = activeAirports.includes(typeId)
      ? activeAirports.filter(t => t !== typeId)
      : [...activeAirports, typeId]
    setActiveAirports(next)
    const f = getAirportFilter(next)
    if (map.current?.getLayer('airports')) map.current.setFilter('airports', f)
    if (map.current?.getLayer('airports-labels')) map.current.setFilter('airports-labels', f)
  }

  const changeBasemap = useCallback((styleId) => {
    if (!map.current) return
    setActiveBasemap(styleId)
    map.current.setStyle(`https://api.maptiler.com/maps/${styleId}/style.json?key=${MAPTILER_KEY}`)
    map.current.once('styledata', () => addOpenAIPLayers(map.current, activeAirports))
  }, [activeAirports])

  useEffect(() => {
    if (map.current) return
    map.current = new maplibregl.Map({
      container: mapContainer.current,
      style: `https://api.maptiler.com/maps/dataviz-light/style.json?key=${MAPTILER_KEY}`,
      center: [CENTER.lon, CENTER.lat],
      zoom: 9,
    })
    map.current.addControl(new maplibregl.NavigationControl(), 'top-right')

    const updateBounds = () => {
      const b = map.current.getBounds()
      setMapBounds({
        latMin: b.getSouth().toFixed(4),
        lonMin: b.getWest().toFixed(4),
        latMax: b.getNorth().toFixed(4),
        lonMax: b.getEast().toFixed(4),
      })
    }

    map.current.on('load', () => {
      addOpenAIPLayers(map.current, activeAirports)
      updateBounds()
      setMapReady(true)
    })
    map.current.on('moveend', updateBounds)
    return () => { map.current?.remove(); map.current = null }
  }, [])

  // Marqueurs trafic — RÉCONCILIÉS EN PLACE (pas de teardown/recreate à chaque poll).
  // Avant : on rasait tous les marqueurs et on recréait chaque <img> → le SVG se rechargeait
  // et « flashait » en noir (icône sans filtre) une frame avant que le filtre CSS s'applique.
  // Maintenant : on crée le marqueur une seule fois, puis on ne met à jour icône/filtre/rotation/
  // label QUE si sa signature a changé → plus de clignotement rouge↔noir.
  useEffect(() => {
    if (!map.current) return
    if (!visible.traffic) {
      Object.values(markersRef.current).forEach(o => o.marker.remove())
      markersRef.current = {}
      return
    }

    const seen = new Set()
    allTargets.forEach(ac => {
      // Appartenance flotte : par HEX (icao24) OU par CALLSIGN. Les FK9 club sans transpondeur
      // apparaissent dans SafeSky avec un hex ≠ leur icao24 enregistré → le match par callsign
      // (immatriculation) les reconnaît quand même comme flotte (rouge) au lieu de trafic (bleu).
      const own      = ac._fleetBeacon
        ? fleetRole.get((ac.call_sign || '').toUpperCase())
        : (fleetOwn.get((ac.id || '').toUpperCase()) || fleetRole.get((ac.call_sign || '').toUpperCase()))   // 'club' | 'owner' | undefined
      const isFleet  = !!own                                       // membre flotte EBBY = émet via ATC
      const isOwner  = own === 'owner'                             // conservé pour le popup (owner/club)

      // Flotte EBBY = ROUGE · trafic SafeSky ambiant = BLEU VIF (lisible sur fond clair ET sombre)
      const iconFilter = isFleet ? FLEET_FILTER : SAFESKY_FILTER
      // (2026-08-15, demande Christophe) SEULE L'ICÔNE porte la couleur (rouge flotte / bleu trafic) ;
      // le label reste BLANC sur fond noir = lisibilité maximale sur tout fond de carte.
      const labelClr   = '#fff'
      const labelBdr   = '1px solid rgba(255,255,255,0.25)'
      const iconSrc    = `/icons/${iconForBeacon(ac.beacon_type)}.svg`
      const rot        = ac.course || 0
      const callTxt    = ac.call_sign || ac.id
      const altTxt     = `${ac.altitude || 0} ft`
      seen.add(ac.id)

      // (DR) reprendre la position AFFICHÉE précédente → la correction converge sans saut
      const prevDr  = drRef.current[ac.id]
      const dispLat = prevDr ? prevDr.dispLat : ac.latitude
      const dispLon = prevDr ? prevDr.dispLon : ac.longitude
      drRef.current[ac.id] = { lat: ac.latitude, lon: ac.longitude, gs: ac.ground_speed || 0,
                               course: rot, t0: Date.now(), dispLat, dispLon }

      let o = markersRef.current[ac.id]
      if (!o) {
        const el = document.createElement('div')
        el.style.cssText = 'display:flex;flex-direction:column;align-items:center;cursor:pointer;'
        const img = document.createElement('img')
        img.style.cssText = 'width:32px;height:32px;transform-origin:center center;'
        const lbl = document.createElement('div')
        lbl.style.cssText = 'margin-top:2px;background:rgba(0,0,0,0.72);border-radius:4px;padding:1px 5px;text-align:center;white-space:nowrap;font-family:monospace;line-height:1.2;'
        const callEl = document.createElement('div'); callEl.style.cssText = 'font-size:10px;font-weight:700;'
        const altEl  = document.createElement('div'); altEl.style.cssText  = 'font-size:9px;font-weight:400;'
        lbl.append(callEl, altEl); el.append(img, lbl)
        const marker = new maplibregl.Marker({ element: el })
          .setLngLat([dispLon, dispLat])
          .setPopup(new maplibregl.Popup({ offset: 25 }))
          .addTo(map.current)
        o = { marker, img, lbl, callEl, altEl, sig: '' }
        markersRef.current[ac.id] = o
      }

      // MAJ visuelle SEULEMENT si un attribut a changé (le src ne bouge pas → pas de reload SVG)
      const sig = `${iconSrc}|${iconFilter}|${rot}|${labelClr}|${labelBdr}|${callTxt}|${altTxt}`
      if (o.sig !== sig) {
        if (o.img.getAttribute('src') !== iconSrc) o.img.setAttribute('src', iconSrc)
        o.img.style.filter = iconFilter
        o.img.style.transform = `rotate(${rot}deg)`
        o.lbl.style.border = labelBdr
        o.callEl.style.color = labelClr; o.callEl.textContent = callTxt
        o.altEl.style.color  = labelClr; o.altEl.textContent  = altTxt
        o.sig = sig
      }

      o.marker.getPopup().setHTML(`
          <div style="font-family:monospace;font-size:12px;line-height:1.6;">
            <b>${callTxt}</b>${isFleet ? ` <span style="color:${FLEET_CLR};">● EBBY FLEET · ${isOwner ? 'owner' : 'club'}</span>` : ` <span style="color:${SAFESKY_CLR};">● SafeSky</span>`}<br/>
            Type: ${ac._fleetBeacon ? 'Balise AeroTrace' : ac.beacon_type}<br/>
            Alt: ${ac.altitude} ft<br/>
            Spd: ${Math.round(ac.ground_speed * 1.852)} km/h<br/>
            Hdg: ${ac.course}°<br/>
            Status: ${ac.status}
          </div>`)
    })

    // retirer les marqueurs des cibles disparues du flux
    Object.keys(markersRef.current).forEach(id => {
      if (!seen.has(id)) { markersRef.current[id].marker.remove(); delete markersRef.current[id]; delete drRef.current[id] }
    })
  }, [allTargets, fleetRole, fleetOwn, visible.traffic])

  // (2026-08-11) DEAD RECKONING d'affichage (demande Christophe) : entre deux polls (5 s), chaque
  // cible avance au cap/vitesse connus (tick 500 ms) ; quand la position réelle arrive, l'affichage
  // CONVERGE vers elle (25 %/tick ≈ correction en ~1,5 s) au lieu de sauter. Gardes : pas
  // d'anticipation sous 15 kt (jitter sol) ni au-delà de 30 s sans donnée (cible gelée).
  useEffect(() => {
    const t = setInterval(() => {
      const now = Date.now()
      Object.entries(drRef.current).forEach(([k, d]) => {
        const o = markersRef.current[k]
        if (!o) return
        const age = (now - d.t0) / 1000
        let tgtLat = d.lat, tgtLon = d.lon
        if (d.gs > 15 && age < 30) {
          const dist = d.gs * 0.514444 * age                     // kt → mètres parcourus
          const cr = (d.course || 0) * Math.PI / 180
          tgtLat = d.lat + (dist * Math.cos(cr)) / 111320
          tgtLon = d.lon + (dist * Math.sin(cr)) / (111320 * Math.cos(d.lat * Math.PI / 180))
        }
        d.dispLat += (tgtLat - d.dispLat) * 0.25
        d.dispLon += (tgtLon - d.dispLon) * 0.25
        o.marker.setLngLat([d.dispLon, d.dispLat])
      })
    }, 500)
    return () => clearInterval(t)
  }, [])

  const panel = { background: 'rgba(5,8,20,0.82)', borderRadius: 10, border: '0.5px solid rgba(255,255,255,0.08)', overflow: 'hidden' }
  const titleStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 10px', cursor: 'pointer', userSelect: 'none' }
  const titleText = { fontSize: 10, fontWeight: 700, fontFamily: 'monospace', letterSpacing: '0.15em', color: 'rgba(255,255,255,0.9)' }
  const triangle = (open) => (
    <span style={{ fontSize: 8, color: 'rgba(255,255,255,0.4)', display: 'inline-block', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s' }}>▶</span>
  )

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div ref={mapContainer} style={{ width: '100%', height: '100%' }} />

      <div style={{ position: 'absolute', top: 12, left: 12, display: 'flex', flexDirection: 'column', gap: 4, zIndex: 10, minWidth: 172 }}>

        {/* AIP LAYERS */}
        <div style={panel}>
          <div style={titleStyle} onClick={() => setPanelOpen(p => ({ ...p, layers: !p.layers }))}>
            <span style={titleText}>AIP LAYERS</span>
            {triangle(panelOpen.layers)}
          </div>
          {panelOpen.layers && (
            <div style={{ padding: '0 8px 8px', display: 'flex', flexDirection: 'column', gap: 2 }}>
              {LAYERS.map(layer => {
                const on = visible[layer.id]
                const hasContent = on && (layer.hasSlider || layer.hasAltSlider || layer.id === 'airports')
                return (
                  <div key={layer.id}>
                    <div onClick={() => toggleLayer(layer.id)} style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      padding: '4px 6px', borderRadius: hasContent ? '6px 6px 0 0' : 6,
                      background: on ? `rgba(${layer.rgb},0.1)` : 'rgba(255,255,255,0.02)',
                      borderLeft: `2px solid ${on ? layer.color : 'rgba(255,255,255,0.07)'}`,
                      cursor: 'pointer', userSelect: 'none',
                    }}>
                      <span style={{ fontSize: 9, fontWeight: 500, fontFamily: 'monospace', letterSpacing: '0.05em', color: on ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.55)' }}>
                        {layer.label}
                      </span>
                      <span style={{ fontSize: 8, color: on ? layer.color : 'rgba(255,255,255,0.35)', fontFamily: 'monospace' }}>
                        {layer.hasSlider && on && `${opacity[layer.id]}%`}
                        {layer.hasAltSlider && on && `${filteredTraffic.length} ✈ · ${formatAlt(altRange[0])}·${formatAlt(altRange[1])}`}
                      </span>
                    </div>

                    {layer.hasSlider && on && (
                      <div onClick={e => e.stopPropagation()} style={{ padding: '4px 6px 5px', background: 'rgba(5,8,20,0.7)', borderLeft: `2px solid ${layer.color}`, borderRadius: '0 0 6px 6px' }}>
                        <SliderTrack value={opacity[layer.id]} max={30} color={layer.color} onChange={v => handleOpacity(layer.id, v)} />
                      </div>
                    )}

                    {layer.id === 'airports' && on && (
                      <div onClick={e => e.stopPropagation()} style={{ padding: '5px 6px 6px', background: 'rgba(5,8,20,0.7)', borderLeft: `2px solid ${layer.color}`, borderRadius: '0 0 6px 6px', display: 'flex', flexDirection: 'column', gap: 3 }}>
                        {AIRPORT_TYPES.map(t => {
                          const checked = activeAirports.includes(t.id)
                          return (
                            <div key={t.id} onClick={() => toggleAirportType(t.id)} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', userSelect: 'none' }}>
                              <div style={{ width: 8, height: 8, borderRadius: 2, border: `1.5px solid ${checked ? layer.color : 'rgba(255,255,255,0.2)'}`, background: checked ? layer.color : 'transparent', flexShrink: 0, transition: 'all 0.15s' }} />
                              <span style={{ fontSize: 9, fontFamily: 'monospace', color: checked ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.6)' }}>{t.label}</span>
                            </div>
                          )
                        })}
                      </div>
                    )}

                    {layer.hasAltSlider && on && (
                      <div onClick={e => e.stopPropagation()} style={{ padding: '5px 6px 6px', background: 'rgba(5,8,20,0.7)', borderLeft: `2px solid ${layer.color}`, borderRadius: '0 0 6px 6px' }}>
                        {[0, 1].map(idx => (
                          <div key={idx} style={{ marginBottom: idx === 0 ? 5 : 0 }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                              <span style={{ fontSize: 8, color: 'rgba(255,255,255,0.55)', fontFamily: 'monospace' }}>{idx === 0 ? 'MIN' : 'MAX'}</span>
                              <span style={{ fontSize: 8, color: layer.color, fontFamily: 'monospace' }}>{formatAlt(altRange[idx])}</span>
                            </div>
                            <SliderTrack value={altRange[idx]} max={ALT_MAX} color={layer.color}
                              onChange={v => setAltRange(prev => idx === 0
                                ? [Math.min(v, prev[1] - 1000), prev[1]]
                                : [prev[0], Math.max(v, prev[0] + 1000)])} />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* MAP */}
        <div style={panel}>
          <div style={titleStyle} onClick={() => setPanelOpen(p => ({ ...p, map: !p.map }))}>
            <span style={titleText}>MAP</span>
            {triangle(panelOpen.map)}
          </div>
          {panelOpen.map && (
            <div style={{ padding: '0 8px 8px', display: 'flex', flexDirection: 'column', gap: 2 }}>
              {BASEMAPS.map(bm => (
                <div key={bm.id} onClick={() => changeBasemap(bm.id)} style={{
                  padding: '4px 6px', borderRadius: 6, cursor: 'pointer',
                  background: activeBasemap === bm.id ? 'rgba(255,255,255,0.08)' : 'transparent',
                  borderLeft: `2px solid ${activeBasemap === bm.id ? 'rgba(255,255,255,0.4)' : 'transparent'}`,
                }}>
                  <span style={{ fontSize: 9, fontFamily: 'monospace', fontWeight: 500, letterSpacing: '0.05em', color: activeBasemap === bm.id ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.55)' }}>
                    {bm.label.toUpperCase()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

      </div>
    </div>
  )
}
