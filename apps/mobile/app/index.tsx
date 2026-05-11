import { Redirect } from 'expo-router'

import { useAuthStatus } from '../src/features/auth'

/**
 * Point d'entrée — redirige en fonction du statut d'auth :
 *   - `restoring`        → reste sur l'index (le RootLayout affiche un overlay)
 *   - `authenticated`    → Home applicatif (`/(app)/home`)
 *   - `unauthenticated`  → Login (`/(auth)/login`)
 */
export default function Index(): JSX.Element | null {
  const status = useAuthStatus()
  if (status === 'restoring') return null
  if (status === 'authenticated') return <Redirect href="/(app)/home" />
  return <Redirect href="/(auth)/login" />
}
