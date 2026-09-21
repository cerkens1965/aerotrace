// (21/09) CADRAGE enregistré dans la fiche : photoZoom (1–3), photoX / photoY (0–100 %, point visé).
// Seules les photos de la fiche sont cadrées ; une photo web auto s'affiche centrée.
export const photoFrame = (ac = {}) => {
  const z = Math.min(3, Math.max(1, Number(ac.photoZoom) || 1))
  const x = Math.min(100, Math.max(0, Number(ac.photoX ?? 50)))
  const y = Math.min(100, Math.max(0, Number(ac.photoY ?? 50)))
  return { width: '100%', height: '100%', display: 'block', objectFit: 'cover',
           objectPosition: `${x}% ${y}%`, transform: z > 1 ? `scale(${z})` : undefined, transformOrigin: `${x}% ${y}%` }
}
