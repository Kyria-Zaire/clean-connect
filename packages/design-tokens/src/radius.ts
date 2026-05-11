/**
 * Clean Connect — border-radius (source de vérité)
 * Référence cahier v1.4 §1 : cartes 16-20px, style épuré.
 */

export const radius = {
  none: '0px',
  xs: '4px',
  sm: '8px',
  md: '12px',
  lg: '16px',
  xl: '20px',
  '2xl': '24px',
  full: '9999px',
} as const

export type Radius = typeof radius
