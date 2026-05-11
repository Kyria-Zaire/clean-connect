import { Redirect, Stack } from 'expo-router'

import { useAuthStatus } from '../../src/features/auth'

/**
 * Segment "(auth)" — réservé aux écrans publics (login, signup).
 * Redirige vers `/(app)/home` si l'utilisateur est déjà authentifié.
 */
export default function AuthLayout(): JSX.Element | null {
  const status = useAuthStatus()
  if (status === 'restoring') return null
  if (status === 'authenticated') return <Redirect href="/(app)/home" />
  return <Stack screenOptions={{ headerShown: false }} />
}
