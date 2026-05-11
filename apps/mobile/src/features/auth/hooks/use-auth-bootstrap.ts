import { useEffect, useRef } from 'react'

import { useAuthStore } from '../store/auth.store'

/**
 * À monter une seule fois au lancement (root layout).
 *
 * Restaure les tokens depuis SecureStore puis appelle `/auth/me`.
 * Logout silencieux si le refresh est invalide (CTO Ticket 1.4 #6).
 */
export function useAuthBootstrap(): void {
  const bootstrap = useAuthStore((s) => s.bootstrap)
  const startedRef = useRef(false)

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    void bootstrap()
  }, [bootstrap])
}
