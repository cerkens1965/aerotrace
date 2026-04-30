// src/pages/DiagPage.jsx
// PAGE TEMPORAIRE — diagnostic Firestore
// Retire après usage

import { useState } from 'react'
import { collection, getDocs } from 'firebase/firestore'
import { db } from '../firebase/config'

const C = { bg: '#050814', text: '#ffffff', amber: '#F5A623', green: '#22c55e', red: '#ef4444', mono: 'monospace' }

export default function DiagPage() {
  const [results, setResults] = useState({})
  const [loading, setLoading] = useState(false)

  const run = async () => {
    setLoading(true)
    const out = {}
    const cols = ['flights', 'pilots', 'aircraft', 'clubs', 'users']

    for (const col of cols) {
      try {
        const snap = await getDocs(collection(db, col))
        const docs = snap.docs.map(d => ({ _id: d.id, ...d.data() }))
        out[col] = { count: docs.length, docs }
      } catch (e) {
        out[col] = { error: e.message }
      }
    }
    setResults(out)
    setLoading(false)
  }

  return (
    <div style={{ minHeight: '100vh', background: C.bg, padding: '80px 32px 48px', fontFamily: C.mono }}>
      <div style={{ color: C.amber, fontSize: 10, letterSpacing: 2, marginBottom: 8 }}>DIAGNOSTIC FIRESTORE</div>
      <h1 style={{ color: C.text, fontSize: 18, margin: '0 0 24px' }}>Collections dump</h1>

      <button onClick={run} disabled={loading} style={{
        background: 'rgba(245,166,35,0.15)', border: '1px solid rgba(245,166,35,0.4)',
        color: C.amber, fontFamily: C.mono, fontSize: 12, padding: '8px 20px',
        borderRadius: 6, cursor: 'pointer', marginBottom: 32,
      }}>
        {loading ? 'Chargement…' : '▶ LANCER LE DIAGNOSTIC'}
      </button>

      {Object.entries(results).map(([col, data]) => (
        <div key={col} style={{ marginBottom: 28 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
            <span style={{ color: C.amber, fontSize: 13, fontWeight: 700 }}>/{col}</span>
            {data.error
              ? <span style={{ color: C.red, fontSize: 11 }}>❌ {data.error}</span>
              : <span style={{ color: data.count > 0 ? C.green : 'rgba(255,255,255,0.4)', fontSize: 11 }}>
                  {data.count > 0 ? `✓ ${data.count} doc${data.count > 1 ? 's' : ''}` : '⚠ VIDE'}
                </span>
            }
          </div>

          {/* Affiche les clés du premier doc pour voir la structure */}
          {data.docs?.length > 0 && (
            <div style={{ background: 'rgba(10,14,30,0.9)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 8, padding: 16, overflow: 'auto', maxHeight: 300 }}>
              <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: 10, marginBottom: 8 }}>
                CHAMPS PRÉSENTS (doc 1) :
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
                {Object.keys(data.docs[0]).map(k => (
                  <span key={k} style={{
                    background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
                    color: C.text, fontSize: 10, padding: '2px 8px', borderRadius: 4,
                  }}>{k}</span>
                ))}
              </div>
              {/* Liste tous les docs avec leurs champs clés */}
              {data.docs.map((d, i) => (
                <div key={i} style={{ borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: 6, marginTop: 6 }}>
                  <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: 9, marginBottom: 3 }}>doc[{i}] id={d._id}</div>
                  <div style={{ color: C.text, fontSize: 11 }}>
                    {Object.entries(d)
                      .filter(([k]) => k !== '_id')
                      .map(([k, v]) => (
                        <span key={k} style={{ marginRight: 14 }}>
                          <span style={{ color: C.amber }}>{k}</span>
                          <span style={{ color: 'rgba(255,255,255,0.4)' }}>: </span>
                          <span style={{ color: v === null || v === undefined ? C.red : C.text }}>
                            {v === null ? 'null'
                              : v === undefined ? 'undefined'
                              : typeof v === 'object' && v?.toDate ? v.toDate().toLocaleDateString('fr-BE')
                              : typeof v === 'object' ? JSON.stringify(v).slice(0, 40)
                              : String(v).slice(0, 40)}
                          </span>
                        </span>
                      ))
                    }
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
