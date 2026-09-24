#!/usr/bin/env node
// coowners.mjs — déclare (ou retire) une COPROPRIÉTÉ sur un aéronef. Outil PROVISOIRE :
// la fiche Admin ne sait écrire qu'un seul propriétaire tant que l'interface n'a pas
// rattrapé le schéma du 24/09. À supprimer le jour où elle le fera.
//
//   node tools/coowners.mjs FJFVB                 → montre l'état actuel, n'écrit rien
//   node tools/coowners.mjs FJFVB CER,PLE         → déclare la copropriété
//   node tools/coowners.mjs FJFVB CER             → revient à un propriétaire unique
//
// Les pilotes se désignent par leur TRIGRAMME. Authentification : le jeton gcloud du poste
// (`gcloud auth print-access-token`), comme pour la publication OTA — pas de clé de service.
//
// Ce que ça change côté vols : à deux noms ou plus, un vol terminé n'est attribué à
// PERSONNE et s'ouvre en revendication. Revenir à un seul nom rétablit l'attribution
// automatique. Les vols DÉJÀ enregistrés ne sont pas retouchés.
import { execSync } from 'node:child_process'

const PROJECT = 'aerotrace-74217'
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`

const [ident, trigrams] = process.argv.slice(2)
if (!ident) {
  console.error('usage : node tools/coowners.mjs <IMMAT|INDICATIF> [TRIGRAMME1,TRIGRAMME2]')
  process.exit(1)
}

const token = execSync('gcloud auth print-access-token', { encoding: 'utf8' }).trim()
const api = async (path, init = {}) => {
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  })
  const j = await r.json()
  if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(j)}`)
  return j
}
const str = (f, k) => f?.[k]?.stringValue || ''
const arr = (f, k) => (f?.[k]?.arrayValue?.values || []).map((v) => v.stringValue)

// ── la fiche aéronef, par indicatif puis par immatriculation ────────────────
const acs = (await api('/aircraft?pageSize=200')).documents || []
const want = ident.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
const ac = acs.find((d) => norm(str(d.fields, 'callSign')) === want)
        || acs.find((d) => norm(str(d.fields, 'registration')) === want)
if (!ac) { console.error(`aéronef « ${ident} » introuvable`); process.exit(1) }

const pilots = (await api('/pilots?pageSize=400')).documents || []
const nameOf = (id) => {
  const p = pilots.find((d) => d.name.endsWith(`/${id}`))
  return p ? `${str(p.fields, 'firstName')} ${str(p.fields, 'lastName')} [${str(p.fields, 'trigram')}]` : id
}

const current = arr(ac.fields, 'ownerPilotIds')
const legacy = str(ac.fields, 'ownerPilotId')
const owners = current.length ? current : (legacy ? [legacy] : [])
console.log(`\n${str(ac.fields, 'callSign') || str(ac.fields, 'registration')} · ${str(ac.fields, 'ownership') || 'club'}`)
console.log(`  propriétaires : ${owners.length ? owners.map(nameOf).join(' + ') : '∅'}`)

if (!trigrams) { console.log('\n(lecture seule — passe une liste de trigrammes pour écrire)\n'); process.exit(0) }

// ── résolution des trigrammes ───────────────────────────────────────────────
const ids = []
for (const t of trigrams.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean)) {
  const hit = pilots.filter((d) => str(d.fields, 'trigram').toUpperCase() === t && !d.fields?.archived?.booleanValue)
  if (hit.length !== 1) { console.error(`trigramme « ${t} » : ${hit.length} fiche(s) — il en faut exactement une`); process.exit(1) }
  ids.push(hit[0].name.split('/').pop())
}
if (!ids.length) { console.error('aucun pilote résolu'); process.exit(1) }

const acId = ac.name.split('/').pop()
await api(`/aircraft/${acId}?updateMask.fieldPaths=ownership&updateMask.fieldPaths=ownerPilotId&updateMask.fieldPaths=ownerPilotIds`, {
  method: 'PATCH',
  body: JSON.stringify({
    fields: {
      ownership: { stringValue: 'owner' },
      ownerPilotId: { stringValue: ids[0] },        // tenu sur le premier : le dashboard le lit encore
      ownerPilotIds: { arrayValue: { values: ids.map((v) => ({ stringValue: v })) } },
    },
  }),
})
console.log(`  → ${ids.map(nameOf).join(' + ')}`)
console.log(ids.length > 1
  ? '\nCopropriété déclarée : les prochains vols ne seront attribués à personne et s\'ouvriront en revendication.\n'
  : '\nPropriétaire unique : les prochains vols lui seront attribués automatiquement.\n')
