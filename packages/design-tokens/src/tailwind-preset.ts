/**
 * Tailwind preset partagé — consommé par apps/admin (Tailwind v3)
 * et apps/mobile (NativeWind v4 utilise Tailwind sous le capot).
 *
 * Usage côté apps/admin/tailwind.config.ts :
 *
 *   import { tailwindPreset } from '@cc/design-tokens/tailwind-preset'
 *
 *   export default {
 *     presets: [tailwindPreset],
 *     content: ['./src/!**!/!*.{ts,tsx}'],
 *   }
 *
 * Usage côté apps/mobile/tailwind.config.ts (identique).
 */

import { colors } from './colors'
import { radius } from './radius'
import { fontFamily, fontSize, fontWeight, lineHeight } from './typography'
import { spacing } from './spacing'

export const tailwindPreset = {
  theme: {
    extend: {
      colors: {
        brand: colors.brand,
        neutral: colors.neutral,
        success: colors.success,
        warning: colors.warning,
        danger: colors.danger,
        info: colors.info,
        surface: colors.surface,
        // 'text' est réservé par Tailwind (text-{color}). On expose via 'fg-*' aliases si besoin.
        border: colors.border,
      },
      borderRadius: radius,
      fontFamily,
      fontSize,
      fontWeight,
      lineHeight,
      spacing,
    },
  },
}

export default tailwindPreset
