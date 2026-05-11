// eslint-disable-next-line @typescript-eslint/require-await
export default async function globalTeardown(): Promise<void> {
  // No-op : les containers test sont gérés par `pnpm db:test:down` côté workflow.
}
