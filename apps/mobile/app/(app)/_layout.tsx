import { Redirect, Stack } from 'expo-router'

import { useAuthStatus } from '../../src/features/auth'

/**
 * Segment "(app)" — réservé aux écrans authentifiés.
 * Redirige vers `/(auth)/login` si la session est absente / expirée.
 */
export default function AppLayout(): JSX.Element | null {
  const status = useAuthStatus()
  if (status === 'restoring') return null
  if (status !== 'authenticated') return <Redirect href="/(auth)/login" />
  return <Stack screenOptions={{ headerShown: false }} />
}
