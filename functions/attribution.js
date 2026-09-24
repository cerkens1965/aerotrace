// attribution.js — QUI est crédité d'un vol, et comment on le sait (24/09/2026, copropriété).
//
// Sorti de index.js pour une raison simple : ces heures finissent dans des carnets de vol et
// dans le suivi d'entretien. Une règle d'attribution ne doit pas être une expression enfouie
// au milieu d'une fonction cloud qu'on ne peut éprouver qu'en déployant — ici elle est pure,
// et `node test/attribution.js` la vérifie en une seconde.
//
// Les entrées viennent de trois sources, par ordre de force :
//   1. DÉCLARÉ À L'AVION — le code saisi sur l'AKview, transporté par le boîtier dans le vol
//      (`pilot_code` / `instr_code`) et résolu en fiche pilote. Horodaté, par quelqu'un qui
//      était physiquement là. C'est le seul savoir fort.
//   2. LA FICHE AÉRONEF — un propriétaire unique se déduit sans risque.
//   3. RIEN — le vol attend une décision humaine.
// Une déduction n'est jamais présentée comme un fait : `pilotSource` dit toujours d'où vient
// l'attribution, et ne s'efface pas.

/**
 * Les propriétaires d'un aéronef, sous forme de LISTE, quelle que soit la génération de la fiche.
 * La fiche portait `ownerPilotId` (un seul) ; `ownerPilotIds` (tableau) devient la source et
 * `ownerPilotId` reste maintenu sur le premier nom, parce que tout le dashboard le lit encore.
 * Ne dit RIEN de la propriété : à n'appeler que sous `ownership === 'owner'`.
 */
function ownersOf(ac) {
  const raw = Array.isArray(ac?.ownerPilotIds) && ac.ownerPilotIds.length
    ? ac.ownerPilotIds
    : (ac?.ownerPilotId ? [ac.ownerPilotId] : [])
  return [...new Set(raw.map((x) => String(x || '').trim()).filter(Boolean))]
}

/**
 * Décide l'attribution d'un vol.
 *
 * @param {string[]} owners     propriétaires de l'appareil ([] si avion club)
 * @param {?{id:string}} pilot  pilote identifié par son code à l'avion, sinon null
 * @param {?{id:string}} instructor instructeur identifié par son code, sinon null
 * @returns {{pilotId:?string, validated:boolean, autoAssigned:?string,
 *            pilotSource:?string, claim:?object}}
 *
 * Les règles, dans l'ordre où elles se lisent :
 *  · un INSTRUCTEUR présent ⇒ jamais d'automatisme. Un vol d'instruction engage deux
 *    personnes et un type de vol ; cela se décide au carnet, pré-rempli.
 *  · un code PILOTE saisi à l'avion ⇒ c'est lui. Auto-validé s'il fait partie des
 *    propriétaires (il vole chez lui, personne d'autre à créditer) ; sinon il part en file
 *    d'attribution, pré-rempli : le boîtier sait QUI, pas à quel titre.
 *  · UN SEUL propriétaire et personne n'a rien déclaré ⇒ c'est lui, auto-validé. C'est la
 *    règle du 21/09, inchangée.
 *  · PLUSIEURS propriétaires et rien de déclaré ⇒ REVENDICATION. Personne n'est crédité en
 *    silence : un carnet qui crédite d'office la mauvaise personne ne se corrige qu'au
 *    prochain audit de licence. On préfère un vol non attribué à un vol faussement attribué.
 *  · avion club sans rien de déclaré ⇒ file d'attribution, comme aujourd'hui.
 */
function decideAttribution(owners, pilot, instructor) {
  const list = [...new Set((owners || []).filter(Boolean))]
  const sole = list.length === 1 ? list[0] : null

  if (instructor) {
    return {
      pilotId: pilot?.id || sole || null,
      validated: false, autoAssigned: null,
      pilotSource: pilot ? 'declared' : null,
      claim: null,
    }
  }

  if (pilot) {
    const isOwner = list.includes(pilot.id)
    return {
      pilotId: pilot.id,
      validated: isOwner, autoAssigned: isOwner ? 'declared' : null,
      pilotSource: 'declared',
      claim: null,
    }
  }

  if (sole) {
    return {
      pilotId: sole,
      validated: true, autoAssigned: 'owner',
      pilotSource: 'owner',
      claim: null,
    }
  }

  if (list.length > 1) {
    return {
      pilotId: null,
      validated: false, autoAssigned: null,
      pilotSource: null,
      claim: { state: 'open', candidates: list, declinedBy: [] },
    }
  }

  return { pilotId: null, validated: false, autoAssigned: null, pilotSource: null, claim: null }
}

module.exports = { ownersOf, decideAttribution }
