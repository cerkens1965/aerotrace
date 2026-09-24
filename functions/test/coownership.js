// Banc d'essai COPROPRIÉTÉ sur le simulateur Firebase (24/09/2026).
//
//   Terminal 1 : cd aerotrace && npx firebase-tools emulators:start --only firestore,functions,auth
//   Terminal 2 : cd aerotrace/functions && node test/coownership.js
//
// Ce que ça éprouve, et que le test unitaire ne peut pas : la CHAÎNE réelle — un vol déposé
// comme le ferait un boîtier, le trigger normalizeFlight qui s'exécute pour de vrai, la
// transaction de revendication, et les règles d'accès de la fonction appelable (club, lien
// compte ↔ fiche pilote). Rien n'est simulé côté code : ce sont les fonctions déployables,
// exécutées sur une base jetable.
const admin = require('firebase-admin')

const PROJECT = 'aerotrace-74217'
const REGION = 'europe-west1'
const FN = `http://127.0.0.1:5001/${PROJECT}/${REGION}`
const AUTH = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1'

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080'
process.env.FIREBASE_AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099'

admin.initializeApp({ projectId: PROJECT })
const db = admin.firestore()

const CLUB = 'EBBY'
const PA = 'pilot-anne', PB = 'pilot-bruno', PC = 'pilot-chris'

let failures = 0
const check = (ok, what, detail = '') => {
  if (ok) console.log(`  ok   ${what}`)
  else { failures++; console.log(`  FAIL ${what}${detail ? `\n       ${detail}` : ''}`) }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Le trigger est asynchrone : on attend que la normalisation ait eu lieu, sans fixer un délai
// arbitraire qui rendrait le test capricieux.
async function waitNormalized(flightId, timeoutMs = 20000) {
  const t0 = Date.now()
  for (;;) {
    const d = (await db.doc(`flights/${flightId}`).get()).data() || {}
    if (d._normalized === true) return d
    if (Date.now() - t0 > timeoutMs) throw new Error(`normalizeFlight n'a pas tourné sur ${flightId} (${timeoutMs} ms)`)
    await sleep(400)
  }
}

// Compte de test dans le simulateur d'authentification → jeton d'identité réel, accepté par
// la fonction appelable exactement comme en production.
async function signIn(email) {
  const r = await fetch(`${AUTH}/accounts:signUp?key=fake-api-key`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'test1234', returnSecureToken: true }),
  })
  const j = await r.json()
  if (!j.idToken) throw new Error(`auth ${email}: ${JSON.stringify(j)}`)
  return { uid: j.localId, token: j.idToken }
}

async function callClaim(token, data) {
  const r = await fetch(`${FN}/claimFlight`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ data }),
  })
  const j = await r.json()
  return j.result ?? j.error ?? j
}

async function seed() {
  const wipe = async (col) => {
    const s = await db.collection(col).get()
    await Promise.all(s.docs.map((d) => d.ref.delete()))
  }
  await Promise.all(['flights', 'aircraft', 'pilots', 'users', 'devices'].map(wipe))

  await db.doc(`pilots/${PA}`).set({ clubId: CLUB, firstName: 'Anne',  lastName: 'Dupont', trigram: 'ADU', pin: '1111' })
  await db.doc(`pilots/${PB}`).set({ clubId: CLUB, firstName: 'Bruno', lastName: 'Martin', trigram: 'BMA', pin: '2222' })
  await db.doc(`pilots/${PC}`).set({ clubId: CLUB, firstName: 'Chris', lastName: 'Leroy',  trigram: 'CLE', pin: '3333' })

  // Copropriété : deux noms sur la même fiche.
  await db.doc('aircraft/ac-duo').set({
    clubId: CLUB, registration: 'OO-DUO', callSign: 'OODUO', typeDesig: 'FK9',
    ownership: 'owner', ownerPilotIds: [PA, PB],
  })
  // Propriétaire unique : la règle du 21/09 ne doit pas bouger.
  await db.doc('aircraft/ac-solo').set({
    clubId: CLUB, registration: 'OO-SOL', callSign: 'OOSOL', typeDesig: 'FK9',
    ownership: 'owner', ownerPilotId: PA,                       // fiche ANCIENNE génération
  })
  // Avion club : ni propriétaire, ni revendication.
  await db.doc('aircraft/ac-club').set({
    clubId: CLUB, registration: 'OO-CLB', callSign: 'OOCLB', typeDesig: 'VL3', ownership: 'club',
  })
}

// Un vol tel que le dépose un boîtier (champs snake_case, pas de CSV : la normalisation
// s'en passe, elle note seulement que les statistiques manquent).
async function dropFlight(id, callSign, extra = {}) {
  await db.doc(`flights/${id}`).set({
    flight_id: id, aircraft_ident: callSign, icao24: '',
    end_ts: Math.floor(Date.now() / 1000), ...extra,
  })
  return waitNormalized(id)
}

async function main() {
  console.log('\nBanc d\'essai copropriété — simulateur Firebase\n')
  await seed()

  // ── 1. migration de schéma par le trigger ──────────────────────────────────
  let solo = {}
  for (let i = 0; i < 25 && !(solo.ownerPilotIds); i++) {
    await sleep(400); solo = (await db.doc('aircraft/ac-solo').get()).data() || {}
  }
  check(JSON.stringify(solo.ownerPilotIds) === JSON.stringify([PA]),
    'fiche ancienne convertie toute seule (ownerPilotId → ownerPilotIds)', JSON.stringify(solo.ownerPilotIds))

  // ── 2. le vol en copropriété n'est attribué à personne ─────────────────────
  const duo = await dropFlight('F-DUO-1', 'OODUO')
  check(duo.pilotId == null, 'copropriété : aucun pilote crédité', `pilotId=${duo.pilotId}`)
  check(duo.validated === false, 'copropriété : vol non validé')
  check(duo.claim?.state === 'open', 'copropriété : revendication ouverte')
  check(JSON.stringify(duo.claim?.candidates?.slice().sort()) === JSON.stringify([PA, PB].sort()),
    'copropriété : les deux copropriétaires sont candidats', JSON.stringify(duo.claim?.candidates))

  // ── 3. propriétaire unique : rien ne change ────────────────────────────────
  const sol = await dropFlight('F-SOL-1', 'OOSOL')
  check(sol.pilotId === PA && sol.validated === true && sol.autoAssigned === 'owner',
    'propriétaire unique : crédité et validé, comme avant',
    `pilotId=${sol.pilotId} validated=${sol.validated} auto=${sol.autoAssigned}`)
  check(sol.pilotSource === 'owner', 'propriétaire unique : provenance « owner »')
  check(sol.claim == null, 'propriétaire unique : pas de revendication')

  // ── 4. code saisi à l'avion par un copropriétaire → il prime ───────────────
  const duoPin = await dropFlight('F-DUO-2', 'OODUO', { pilot_code: '2222' })
  check(duoPin.pilotId === PB && duoPin.validated === true && duoPin.pilotSource === 'declared',
    'code saisi par un copropriétaire : crédité, validé, déclaré',
    `pilotId=${duoPin.pilotId} validated=${duoPin.validated} src=${duoPin.pilotSource}`)
  check(duoPin.claim == null, 'code saisi : pas de revendication à ouvrir')

  // ── 5. avion club : file d'attribution, inchangé ───────────────────────────
  const clb = await dropFlight('F-CLB-1', 'OOCLB')
  check(clb.pilotId == null && clb.validated === false && clb.claim == null,
    'avion club : file d\'attribution, sans revendication')

  // ── 6. la revendication elle-même ──────────────────────────────────────────
  const anne  = await signIn('anne@test.local')
  const bruno = await signIn('bruno@test.local')
  const chris = await signIn('chris@test.local')
  await db.doc(`users/${anne.uid}`).set({ email: 'anne@test.local',  role: 'user', clubId: CLUB, pilotId: PA })
  await db.doc(`users/${bruno.uid}`).set({ email: 'bruno@test.local', role: 'user', clubId: CLUB, pilotId: PB })
  await db.doc(`users/${chris.uid}`).set({ email: 'chris@test.local', role: 'user', clubId: CLUB, pilotId: PC })

  const intrus = await callClaim(chris.token, { flightId: 'F-DUO-1' })
  check(intrus?.status === 'PERMISSION_DENIED' || /not yours/i.test(intrus?.message || ''),
    'un pilote qui n\'est pas copropriétaire ne peut pas revendiquer', JSON.stringify(intrus))

  const pris = await callClaim(anne.token, { flightId: 'F-DUO-1' })
  check(pris?.state === 'claimed', 'Anne revendique : accepté', JSON.stringify(pris))
  let f1 = (await db.doc('flights/F-DUO-1').get()).data()
  check(f1.pilotId === PA && f1.validated === true && f1.pilotSource === 'claimed',
    'le vol est à Anne, avec la provenance « claimed »',
    `pilotId=${f1.pilotId} validated=${f1.validated} src=${f1.pilotSource}`)
  check(f1.claim?.state === 'settled', 'revendication réglée')

  const tard = await callClaim(bruno.token, { flightId: 'F-DUO-1' })
  check(tard?.state === 'conflict' && tard?.pilotId === PA,
    'Bruno revendique après coup : conflit, le vol n\'est PAS volé', JSON.stringify(tard))
  f1 = (await db.doc('flights/F-DUO-1').get()).data()
  check(f1.pilotId === PA, 'après conflit, le vol appartient toujours au premier')
  check(f1.claim?.state === 'disputed' && (f1.claim?.disputedBy || []).includes(PB),
    'le conflit est tracé pour l\'admin', JSON.stringify(f1.claim))

  // ── 7. « ce n'est pas moi » ─────────────────────────────────────────────────
  const duo3 = await dropFlight('F-DUO-3', 'OODUO')
  check(duo3.claim?.state === 'open', 'deuxième vol en copropriété : revendication ouverte')
  const nonA = await callClaim(anne.token,  { flightId: 'F-DUO-3', mine: false })
  check(nonA?.state === 'declined', 'Anne récuse : en attente de l\'autre', JSON.stringify(nonA))
  const nonB = await callClaim(bruno.token, { flightId: 'F-DUO-3', mine: false })
  check(nonB?.state === 'unclaimed', 'les deux récusent : le vol part en file d\'attribution', JSON.stringify(nonB))

  // ── 8. le propriétaire qui a prêté son avion rend le vol ───────────────────
  const rendu = await callClaim(anne.token, { flightId: 'F-SOL-1', mine: false })
  check(rendu?.state === 'released', 'propriétaire unique : « ce n\'est pas moi » accepté', JSON.stringify(rendu))
  const sol2 = (await db.doc('flights/F-SOL-1').get()).data()
  check(sol2.pilotId == null && sol2.validated === false && sol2.autoAssigned == null,
    'le vol rendu retourne en file d\'attribution',
    `pilotId=${sol2.pilotId} validated=${sol2.validated} auto=${sol2.autoAssigned}`)

  console.log(`\n${failures ? `${failures} ÉCHEC(S)` : 'tout passe'}\n`)
  process.exit(failures ? 1 : 0)
}

main().catch((e) => { console.error('\nbanc d\'essai interrompu :', e.message, '\n'); process.exit(2) })
