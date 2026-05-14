import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import { useAtCorePositions } from '../../hooks/useAtCorePositions';

const MODE = {
  0: { color: '#ffffff', label: 'GROUND'   },
  1: { color: '#22c55e', label: 'CRUISE'   },
  2: { color: '#f97316', label: 'MANEUVER' },
  3: { color: '#F5A623', label: 'APPROACH' },
  4: { color: '#ef4444', label: 'CRITICAL' },
};
const modeOf = (m) => MODE[m] ?? MODE[0];

const planeSVG = (color, hdg) => `<svg viewBox="0 0 24 24" width="30" height="30" style="transform:rotate(${hdg}deg);display:block;filter:drop-shadow(0 2px 5px rgba(0,0,0,.9))"><path fill="${color}" d="M21 16v-2l-8-5V3.5C13 2.67 12.33 2 11.5 2S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"/></svg>`;

function popupHTML(pos) {
  const { color, label } = modeOf(pos.mode);
  const coColor = (pos.co_ppm ?? 0) > 20 ? '#ef4444' : '#ffffff';
  return `<div style="background:#0d0d0d;border:1px solid ${color};border-radius:8px;padding:10px 14px;min-width:170px;font-family:monospace;font-size:11px;color:#fff;line-height:1.9;"><div style="color:${color};font-size:13px;font-weight:700;letter-spacing:1px;margin-bottom:6px;">✈ ${pos.aircraft_ident ?? pos.icao24 ?? 'AT-CORE'}</div><div><span style="color:rgba(255,255,255,.45)">MODE </span><span style="color:${color};font-weight:700">${label}</span></div><div><span style="color:rgba(255,255,255,.45)">ALT  </span>${pos.alt_m ?? 0} m</div><div><span style="color:rgba(255,255,255,.45)">SPD  </span>${pos.spd_kt ?? 0} kt</div><div><span style="color:rgba(255,255,255,.45)">HDG  </span>${pos.hdg ?? 0}°</div><div><span style="color:rgba(255,255,255,.45)">RPM  </span>${pos.rpm ?? 0}</div><div><span style="color:rgba(255,255,255,.45)">CO   </span><span style="color:${coColor}">${pos.co_ppm ?? 0} ppm</span></div></div>`;
}

function makeElement(pos) {
  const { color } = modeOf(pos.mode);
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;cursor:pointer;user-select:none;';
  const icon = document.createElement('div');
  icon.className = 'atcore-icon';
  icon.innerHTML = planeSVG(color, pos.hdg ?? 0);
  const label = document.createElement('div');
  label.className = 'atcore-label';
  label.textContent = pos.aircraft_ident ?? pos.icao24 ?? '';
  label.style.cssText = `color:${color};font-size:10px;font-weight:700;letter-spacing:.5px;text-shadow:0 1px 4px rgba(0,0,0,.95);margin-top:1px;white-space:nowrap;font-family:monospace;`;
  wrap.appendChild(icon);
  wrap.appendChild(label);
  return wrap;
}

export function AtCoreMarkerLayer({ map }) {
  const positions = useAtCorePositions();
  const markersRef = useRef({});

  useEffect(() => {
    if (!map) return;
    const seen = new Set();
    positions.forEach((pos) => {
      if (pos.lat == null || pos.lon == null) return;
      const key = pos._key;
      seen.add(key);
      const existing = markersRef.current[key];
      if (existing) {
        const { marker, popup, iconEl, labelEl } = existing;
        marker.setLngLat([pos.lon, pos.lat]);
        const { color } = modeOf(pos.mode);
        iconEl.innerHTML = planeSVG(color, pos.hdg ?? 0);
        labelEl.textContent = pos.aircraft_ident ?? pos.icao24 ?? '';
        labelEl.style.color = color;
        popup.setHTML(popupHTML(pos));
      } else {
        const el = makeElement(pos);
        const iconEl = el.querySelector('.atcore-icon');
        const labelEl = el.querySelector('.atcore-label');
        const popup = new maplibregl.Popup({ offset: 22, closeButton: false, closeOnClick: false, maxWidth: '220px' }).setHTML(popupHTML(pos));
        const marker = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([pos.lon, pos.lat]).setPopup(popup).addTo(map);
        el.addEventListener('click', (e) => { e.stopPropagation(); marker.togglePopup(); });
        markersRef.current[key] = { marker, popup, iconEl, labelEl };
      }
    });
    Object.keys(markersRef.current).forEach((key) => {
      if (!seen.has(key)) { markersRef.current[key].marker.remove(); delete markersRef.current[key]; }
    });
  }, [positions, map]);

  useEffect(() => {
    return () => { Object.values(markersRef.current).forEach(({ marker }) => marker.remove()); markersRef.current = {}; };
  }, []);

  return null;
}
