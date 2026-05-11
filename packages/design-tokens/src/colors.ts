/**
 * Clean Connect — palette de couleurs (source de vérité unique)
 *
 * Référence cahier v1.4 §1 : blanc + vert principal #22c55e, sans dégradés.
 * Toute couleur utilisée dans l'app DOIT venir de ce fichier.
 * Ajouter une couleur ici ne se fait que via PRD + ADR si elle est structurante.
 */

export const colors = {
  // Marque
  brand: {
    DEFAULT: '#22c55e',
    50: '#f0fdf4',
    100: '#dcfce7',
    200: '#bbf7d0',
    300: '#86efac',
    400: '#4ade80',
    500: '#22c55e',
    600: '#16a34a',
    700: '#15803d',
    800: '#166534',
    900: '#14532d',
    950: '#052e16',
  },

  // Neutres (basés sur Tailwind slate, légèrement réchauffés)
  white: '#ffffff',
  black: '#000000',
  neutral: {
    50: '#fafafa',
    100: '#f5f5f5',
    200: '#e5e5e5',
    300: '#d4d4d4',
    400: '#a3a3a3',
    500: '#737373',
    600: '#525252',
    700: '#404040',
    800: '#262626',
    900: '#171717',
    950: '#0a0a0a',
  },

  // Sémantiques
  success: '#22c55e',
  warning: '#f59e0b',
  danger: '#ef4444',
  info: '#3b82f6',

  // Surfaces
  surface: {
    DEFAULT: '#ffffff',
    muted: '#f5f5f5',
    inverse: '#171717',
  },

  // Texte
  text: {
    DEFAULT: '#171717',
    muted: '#525252',
    inverse: '#ffffff',
    onBrand: '#ffffff',
  },

  // Bordures
  border: {
    DEFAULT: '#e5e5e5',
    strong: '#a3a3a3',
  },
} as const

export type Colors = typeof colors
