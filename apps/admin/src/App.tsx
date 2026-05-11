import { formatEUR } from '@cc/shared-types'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 10_000, retry: 2 },
    mutations: { retry: false },
  },
})

export function App(): JSX.Element {
  return (
    <QueryClientProvider client={queryClient}>
      <main className="flex min-h-screen flex-col items-center justify-center bg-white px-6">
        <h1 className="mb-2 text-4xl font-bold text-neutral-900">Clean Connect — Admin</h1>
        <p className="mb-6 text-neutral-600">
          Bootstrap admin OK · Vite + React + Tailwind (preset @cc/design-tokens)
        </p>
        <div className="rounded-2xl bg-brand px-6 py-4 text-white">
          Démo commission : {formatEUR(19900)} → commission {formatEUR(3582)}
        </div>
        <p className="mt-6 text-sm text-neutral-500">
          {'shadcn/ui sera scaffoldé au premier PRD touchant l\'admin.'}
        </p>
      </main>
    </QueryClientProvider>
  )
}
