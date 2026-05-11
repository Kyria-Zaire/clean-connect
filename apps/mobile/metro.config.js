/* eslint-env node */
const { getDefaultConfig } = require('expo/metro-config')
const { withNativeWind } = require('nativewind/metro')
const fs = require('fs')
const path = require('path')

const projectRoot = __dirname
const workspaceRoot = path.resolve(projectRoot, '../..')

const config = getDefaultConfig(projectRoot)

// Monorepo support — résolution dans le workspace + node_modules racine
config.watchFolders = [workspaceRoot]
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
]
config.resolver.disableHierarchicalLookup = true

// TODO(debt): pnpm node-linker=isolated + Metro = export web instable (Metro ne suit pas les symlinks
// vers .pnpm/...). Le dev natif (Expo Go) fonctionne ; pour Expo web il faudra soit basculer le workspace
// sur node-linker=hoisted, soit forcer des extraNodeModules ciblés. Cf. ticket Sprint 0 follow-up.
//
// pnpm + monorepo : une partie des imports expo-router repart vers node_modules/.pnpm à la racine,
// ce qui casse la résolution relative et les transforms (EXPO_ROUTER_APP_ROOT). On normalise tout vers le paquet local.
const metroConfig = withNativeWind(config, { input: './global.css' })
const expoRouterPkgRoot = path.join(projectRoot, 'node_modules', 'expo-router')

/**
 * @param {string} moduleName
 * @returns {string | null}
 */
function resolvePnpmExpoRouterToLocal(moduleName) {
  if (typeof moduleName !== 'string') return null
  const normalized = moduleName.replace(/\\/g, '/')
  if (!normalized.includes('.pnpm/') || !normalized.includes('expo-router')) return null
  const marker = '/node_modules/expo-router/'
  const idx = normalized.lastIndexOf(marker)
  if (idx === -1) return null
  const suffix = normalized.slice(idx + marker.length)
  const candidate = path.join(expoRouterPkgRoot, suffix)
  return fs.existsSync(candidate) ? candidate : null
}

const previousResolveRequest = metroConfig.resolver.resolveRequest
metroConfig.resolver.resolveRequest = (context, moduleName, platform) => {
  const fromName = resolvePnpmExpoRouterToLocal(moduleName)
  if (fromName) {
    return { type: 'sourceFile', filePath: fromName }
  }

  const resolved = previousResolveRequest
    ? previousResolveRequest(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform)

  if (
    resolved &&
    typeof resolved === 'object' &&
    resolved.type === 'sourceFile' &&
    typeof resolved.filePath === 'string'
  ) {
    const fromPath = resolvePnpmExpoRouterToLocal(resolved.filePath)
    if (fromPath) {
      return { type: 'sourceFile', filePath: fromPath }
    }
  }

  return resolved
}

module.exports = metroConfig
