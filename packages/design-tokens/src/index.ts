/**
 * @cc/design-tokens — point d'entrée
 *
 * Source de vérité unique pour les tokens visuels Clean Connect.
 * Consommée par :
 *   - apps/admin (Tailwind v3 via preset)
 *   - apps/mobile (NativeWind v4 via preset Tailwind partagé)
 *
 * Référence : Cahier v1.4 §1 (identité visuelle).
 */

export { colors } from './colors'
export type { Colors } from './colors'

export { radius } from './radius'
export type { Radius } from './radius'

export { fontFamily, fontSize, fontWeight, lineHeight } from './typography'
export type { FontFamily, FontSize, FontWeight, LineHeight } from './typography'

export { spacing } from './spacing'
export type { Spacing } from './spacing'
