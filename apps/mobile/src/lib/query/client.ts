import { QueryClient } from '@tanstack/react-query'

/**
 * Query client unique pour l'app mobile.
 * - staleTime court (10 s) car données métier volatiles (missions, paiements).
 * - retry désactivé sur les mutations (idempotence côté serveur, cf. règle backend).
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      retry: 2,
    },
    mutations: {
      retry: false,
    },
  },
})
