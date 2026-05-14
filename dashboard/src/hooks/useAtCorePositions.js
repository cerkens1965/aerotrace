import { useEffect, useState, useRef } from 'react';
import { collection, onSnapshot, query, limit } from 'firebase/firestore';
import { db } from '../firebase/config';

export function useAtCorePositions() {
  const [positions, setPositions] = useState([]);
  const posMapRef = useRef({});

  useEffect(() => {
    const q = query(collection(db, 'positions'), limit(500));
    const unsub = onSnapshot(q, (snapshot) => {
      let changed = false;
      snapshot.docChanges().forEach(({ type, doc }) => {
        if (type === 'removed') return;
        const data = doc.data();
        const key = data.icao24 || doc.id;
        const prev = posMapRef.current[key];
        if (!prev || prev.lat !== data.lat || prev.lon !== data.lon || prev.hdg !== data.hdg || prev.mode !== data.mode) {
          posMapRef.current[key] = { _docId: doc.id, _key: key, ...data };
          changed = true;
        }
      });
      if (changed) setPositions(Object.values(posMapRef.current));
    }, (err) => console.error('[useAtCorePositions]', err));
    return () => unsub();
  }, []);

  return positions;
}
