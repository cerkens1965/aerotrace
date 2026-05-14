import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import { useAtCorePositions } from '../../hooks/useAtCorePositions';

// CSS filter that turns the black VL3.svg icon to #ef4444 (red)
const RED_FILTER = 'brightness(0) saturate(100%) invert(27%) sepia(94%) saturate(1832%) hue-rotate(337deg) brightness(103%)';

const MODE = {
  0: { label: 'GROUND'   },
  1: { label: 'CRUISE'   },
  2: { label: 'MANEUVER' },
  3: { label: 'APPROACH' },
  4: { label: 'CRITICAL' },
};
const modeOf = (m) => MODE[m] ?? MODE[0];

function popupHTML(pos) {
  const { label } = modeOf(pos.mode);
  const coColor = (pos.co_ppm ?? 0) > 20 ? '#ef4444' : '#ffffff';
  return `<div style="background:#0d0d0d;border:1px solid #ef4444;border-radius:8px;padding:10px 14px;min-width:170px;font-family:monospace;font-size:11px;color:#fff;line-height:1.9;"><div style="color:#ef4444;font-size:13px;font-weight:700;letter-spacing:1px;margin-bottom:6px;">✈ ${pos.aircraft_ident ?? pos.icao24 ?? 'AT-CORE'}</div><div><span style="color:rgba(255,255,255,.45)">MODE </span><span style="color:#ef4444;font-weight:700">${label}</span></div><div><span style="color:rgba(255,255,255,.45)">ALT  </span>${pos.alt_m ?? 0} m</div><div><span style="color:rgba(255,255,255,.45)">SPD  </span>${pos.spd_kt ?? 0} kt</div><div><span style="color:rgba(255,255,255,.45)">HDG  </span>${pos.hdg ?? 0}°</div><div><span style="color:rgba(255,255,255,.45)">RPM  </span>${pos.rpm ?? 0}</div><div><span style="color:rgba(255,255,255,.45)">CO   </span><span style="color:${coColor}">${pos.co_ppm ?? 0} ppm</span></div></div>`;
}

function makeElement(pos) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;cursor:pointer;user-select:none;';
  const img = document.createElement('img');
  img.className = 'atcore-icon';
  img.src = '/icons/VL3.svg';
  img.style.cssText = `width:32px;height:32px;transform:rotate(${pos.hdg ?? 0}deg);transform-origin:center center;filter:${RED_FILTER};`;
  const label = document.createElement('div');
  label.className = 'atcore-label';
  label.textContent = pos.aircraft_ident ?? pos.icao24 ?? '';
  label.style.cssText = 'color:#ef4444;font-size:10px;font-weight:700;letter-spacing:.5px;text-shadow:0 1px 4px rgba(0,0,0,.95);margin-top:2px;white-space:nowrap;font-family:monospace;';
  wrap.appendChild(img);
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
        iconEl.style.transform = `rotate(${pos.hdg ?? 0}deg)`;
        labelEl.textContent = pos.aircraft_ident ?? pos.icao24 ?? '';
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
