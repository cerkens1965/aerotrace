# EMnify API — référence intégration AeroTrace (P3 conso data LTE)

Source : https://docs.emnify.com/developers/api/authentication/authenticate
(sauvegardé le 2026-07-29 — vérifier la doc live en cas de doute)

## Base

- **Host** : `https://cdn.emnify.net/api/v1`
- **Rate limit** de `/authenticate` : **100 requêtes / IP / 5 min**.

## 1. Authentification — `POST /authenticate`

`Content-Type: application/json`. Plusieurs méthodes ; on utilise l'**Application Token**
(machine-à-machine, n'expire pas — créé dans le portail EMnify → **Integrations → API Tokens**).

Corps (Application Token) :
```json
{ "application_token": "<TOKEN>" }
```

Autres méthodes possibles (non utilisées ici) :
- `{ "username": "...", "password": "<SHA-1>" }` (identifiants user + MFA éventuel)
- `{ "refresh_token": "..." }` (renouvellement, flux user seulement)
- MFA : `{ "mfa_token", "code" (OTP 6 chiffres), "trusted_device": {...} }` — trusted device 90 j.

Réponse **200** :
```json
{
  "auth_token": "<JWT>",
  "refresh_token": "<JWT, flux user credentials seulement>",
  "mfa_token": "<JWT, flux MFA seulement>"
}
```

## 2. Utilisation du token

Toutes les requêtes suivantes : header **`Authorization: Bearer <auth_token>`**.
(La doc ne précise pas explicitement « Bearer » mais c'est le format standard EMnify —
confirmé à l'usage.)

## 3. Endpoints utilisés par la Cloud Function `runEmnifySync` (functions/index.js)

- `GET /endpoint?page=N&per_page=100` → liste paginée des endpoints (SIMs). Chaque objet :
  `{ id, name, status: { id, description }, sim: { id, iccid, ... }, ... }`.
- `GET /endpoint/{id}/stats/month` → volume data du mois. ⚠️ **schéma non figé** — l'extraction
  du volume (`extractVolumeBytes`) essaie plusieurs chemins (`volume.total` / `data_volume` /
  `rx`+`tx`) et **logue le 1er payload brut** (`[emnify] stats sample`) pour ajuster au 1er run réel.

## 4. Côté AeroTrace

- **Secret** Firebase : `EMNIFY_APP_TOKEN` (`firebase functions:secrets:set EMNIFY_APP_TOKEN`).
  ⚠️ Après changement de valeur → **redéployer** les fonctions (v2 pin la version du secret au deploy).
- **Pivot** = ICCID : le boîtier remonte `AT+CICCID` dans `/devices/{boxId}.iccid` (firmware **v105+**).
  Match tolérant préfixe (check-digit 19↔20 chiffres) dans `iccidMatch`.
- Écrit `dataUsageMB`/`simStatus`/`emnifyEndpointId` dans `/devices/{boxId}` (merge) +
  `totalUsedMB`/compteurs dans `/fleetMeta/emnify`. **`poolTotalMB`** (barre %) = saisi à la main
  (endpoint « data pool » EMnify incertain ; le consommé total est sommé depuis les SIM).
- Fonctions : `refreshEmnify` (callable admin, bouton FLEET) + `emnifyUsageScheduled` (every 6h).

## 5. Où trouver l'Application Token (portail)

portal.emnify.com → menu organisation → **Integrations** → **API Tokens** → **Create Application
Token** → copier la chaîne (ne se réaffiche pas).
