// node test/attribution.js — éprouve les règles d'attribution d'un vol (24/09/2026).
// Aucune dépendance, aucun émulateur : la décision est une fonction pure, elle se vérifie ici.
// Ces heures partent dans des carnets de vol ; une règle fausse ne se voit qu'à l'audit.
const assert = require('assert')
const { ownersOf, decideAttribution } = require('../attribution')

const A = 'pilotA', B = 'pilotB', C = 'pilotC'
const cases = []
const it = (name, fn) => cases.push([name, fn])

// ── ownersOf : les deux générations de fiche, et le ménage ────────────────────
it('fiche ancienne : ownerPilotId seul devient une liste', () => {
  assert.deepStrictEqual(ownersOf({ ownerPilotId: A }), [A])
})
it('fiche neuve : ownerPilotIds fait foi', () => {
  assert.deepStrictEqual(ownersOf({ ownerPilotId: A, ownerPilotIds: [B, C] }), [B, C])
})
it('tableau vide : on retombe sur le champ historique', () => {
  assert.deepStrictEqual(ownersOf({ ownerPilotId: A, ownerPilotIds: [] }), [A])
})
it('doublons et blancs écartés', () => {
  assert.deepStrictEqual(ownersOf({ ownerPilotIds: [A, ' ', A, '', B] }), [A, B])
})
it('aucun propriétaire', () => {
  assert.deepStrictEqual(ownersOf({}), [])
  assert.deepStrictEqual(ownersOf(null), [])
})

// ── un seul propriétaire : la règle du 21/09, inchangée ──────────────────────
it('propriétaire unique, rien de déclaré → crédité et validé', () => {
  const d = decideAttribution([A], null, null)
  assert.strictEqual(d.pilotId, A)
  assert.strictEqual(d.validated, true)
  assert.strictEqual(d.autoAssigned, 'owner')
  assert.strictEqual(d.pilotSource, 'owner')
  assert.strictEqual(d.claim, null)
})
it('propriétaire unique + instructeur → jamais automatique, pré-rempli', () => {
  const d = decideAttribution([A], null, { id: C })
  assert.strictEqual(d.pilotId, A)
  assert.strictEqual(d.validated, false)
  assert.strictEqual(d.autoAssigned, null)
})
it('propriétaire unique mais un AUTRE pilote a saisi son code → lui, sans validation', () => {
  const d = decideAttribution([A], { id: B }, null)
  assert.strictEqual(d.pilotId, B)
  assert.strictEqual(d.validated, false)          // le boîtier sait QUI, pas à quel titre
  assert.strictEqual(d.pilotSource, 'declared')
})
it('propriétaire unique qui saisit son propre code → validé', () => {
  const d = decideAttribution([A], { id: A }, null)
  assert.strictEqual(d.pilotId, A)
  assert.strictEqual(d.validated, true)
  assert.strictEqual(d.pilotSource, 'declared')
})

// ── copropriété : le cœur du sujet ───────────────────────────────────────────
it('deux propriétaires, rien de déclaré → PERSONNE crédité, revendication ouverte', () => {
  const d = decideAttribution([A, B], null, null)
  assert.strictEqual(d.pilotId, null)
  assert.strictEqual(d.validated, false)
  assert.strictEqual(d.autoAssigned, null)
  assert.strictEqual(d.pilotSource, null)
  assert.deepStrictEqual(d.claim, { state: 'open', candidates: [A, B], declinedBy: [] })
})
it('trois propriétaires : tous candidats', () => {
  assert.deepStrictEqual(decideAttribution([A, B, C], null, null).claim.candidates, [A, B, C])
})
it('copropriété + code saisi par un copropriétaire → validé, pas de revendication', () => {
  const d = decideAttribution([A, B], { id: B }, null)
  assert.strictEqual(d.pilotId, B)
  assert.strictEqual(d.validated, true)
  assert.strictEqual(d.autoAssigned, 'declared')
  assert.strictEqual(d.claim, null)
})
it('copropriété + code saisi par un tiers → lui, file d’attribution', () => {
  const d = decideAttribution([A, B], { id: C }, null)
  assert.strictEqual(d.pilotId, C)
  assert.strictEqual(d.validated, false)
  assert.strictEqual(d.claim, null)
})
it('copropriété + instructeur → décision humaine, aucun candidat pré-rempli', () => {
  const d = decideAttribution([A, B], null, { id: C })
  assert.strictEqual(d.pilotId, null)             // à plusieurs, on ne devine pas
  assert.strictEqual(d.validated, false)
  assert.strictEqual(d.claim, null)
})
it('doublon dans la fiche : deux fois le même nom n’est PAS une copropriété', () => {
  const d = decideAttribution([A, A], null, null)
  assert.strictEqual(d.pilotId, A)
  assert.strictEqual(d.validated, true)
})

// ── avion club : inchangé ────────────────────────────────────────────────────
it('avion club, rien de déclaré → file d’attribution', () => {
  const d = decideAttribution([], null, null)
  assert.strictEqual(d.pilotId, null)
  assert.strictEqual(d.validated, false)
  assert.strictEqual(d.claim, null)
})
it('avion club + code pilote → lui, non validé', () => {
  const d = decideAttribution([], { id: A }, null)
  assert.strictEqual(d.pilotId, A)
  assert.strictEqual(d.validated, false)
  assert.strictEqual(d.pilotSource, 'declared')
})

// ── invariant : rien n’est validé sans qu’on sache d’où ça vient ─────────────
it('invariant — un vol validé porte toujours une provenance', () => {
  const owners = [[], [A], [A, B], [A, B, C]]
  const pilots = [null, { id: A }, { id: C }]
  const instrs = [null, { id: B }]
  for (const o of owners) for (const p of pilots) for (const i of instrs) {
    const d = decideAttribution(o, p, i)
    if (d.validated) {
      assert.ok(d.pilotId, `validé sans pilote : ${JSON.stringify({ o, p, i })}`)
      assert.ok(d.pilotSource, `validé sans provenance : ${JSON.stringify({ o, p, i })}`)
    }
    if (d.claim) assert.strictEqual(d.pilotId, null, 'revendication ouverte ET pilote crédité')
  }
})

let bad = 0
for (const [name, fn] of cases) {
  try { fn(); console.log(`  ok   ${name}`) }
  catch (e) { bad++; console.log(`  FAIL ${name}\n       ${e.message}`) }
}
console.log(`\n${cases.length - bad}/${cases.length} vérifications passées`)
process.exit(bad ? 1 : 0)
