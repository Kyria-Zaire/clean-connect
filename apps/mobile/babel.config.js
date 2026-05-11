/** @type {import('@babel/core').ConfigFunction} */
module.exports = function (api) {
  api.cache(true)
  return {
    // TODO(debt): réactiver preset nativewind/babel quand RN/Reanimated exposent react-native-worklets
    // compatible Expo 51 (cf. react-native-css-interop/babel.js — plugin worklets).
    presets: [['babel-preset-expo', { jsxImportSource: 'nativewind' }]],
    plugins: ['react-native-reanimated/plugin'],
  }
}
