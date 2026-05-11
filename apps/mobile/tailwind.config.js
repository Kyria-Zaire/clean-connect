/* eslint-env node */
const { tailwindPreset } = require('@cc/design-tokens/tailwind-preset')

/** @type {import('tailwindcss').Config} */
module.exports = {
  presets: [require('nativewind/preset'), tailwindPreset],
  content: ['./app/**/*.{ts,tsx}', './src/**/*.{ts,tsx}'],
}
