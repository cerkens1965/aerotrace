// Versioning dashboard AeroTrace — affiché dans le Header.
//
// APP_VERSION : bump MANUEL à chaque déploiement notable (comme FW_VERSION côté
//   firmware). Incrémenter avant `npm run build && firebase deploy`.
// APP_CHANNEL : 'dev' tant que l'app n'est pas stabilisée ; passer à 'prod' plus tard.
// BUILD_DATE  : injecté AUTOMATIQUEMENT par Vite au build (cf vite.config.js).
//   C'est l'indicateur anti-cache : si la date affichée sur la tablette n'est pas
//   celle du dernier build, le navigateur sert un bundle périmé → hard reload.

export const APP_VERSION = 'v2'
export const APP_CHANNEL = 'dev'
// eslint-disable-next-line no-undef
export const BUILD_DATE = typeof __BUILD_DATE__ !== 'undefined' ? __BUILD_DATE__ : 'dev'
