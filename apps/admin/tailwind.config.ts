import { tailwindPreset } from '@cc/design-tokens/tailwind-preset'
import type { Config } from 'tailwindcss'

export default {
  presets: [tailwindPreset],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
} satisfies Config
