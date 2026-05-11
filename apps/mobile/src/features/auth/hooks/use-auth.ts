import { useAuthStore } from '../store/auth.store'

/**
 * Sélecteurs Zustand granulaires — évitent les re-render inutiles.
 */
export const useAuthStatus = (): ReturnType<typeof useAuthStore.getState>['status'] =>
  useAuthStore((s) => s.status)

export const useAuthUser = (): ReturnType<typeof useAuthStore.getState>['user'] =>
  useAuthStore((s) => s.user)

export const useAuthPending = (): ReturnType<typeof useAuthStore.getState>['pending'] =>
  useAuthStore((s) => s.pending)

export const useAuthError = (): ReturnType<typeof useAuthStore.getState>['lastError'] =>
  useAuthStore((s) => s.lastError)
