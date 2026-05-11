import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

import { useAuthPending, useAuthStore, useAuthUser } from '../../src/features/auth'
import { rolesFromUserRole } from '../../src/lib/auth/role'

/**
 * Écran d'accueil minimaliste post-auth (PRD-001 Ticket 1.4).
 * Vérifie l'hydratation `/auth/me` (CTO #1) + propose un logout (CTO #6).
 * L'UI finale arrivera dans les PRDs missions / paiements.
 */
export default function HomeRoute(): JSX.Element {
  const user = useAuthUser()
  const logout = useAuthStore((s) => s.logout)
  const pending = useAuthPending()

  if (!user) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-white">
        <ActivityIndicator color="#22c55e" />
      </SafeAreaView>
    )
  }

  const roles = rolesFromUserRole(user.role)

  return (
    <SafeAreaView className="flex-1 bg-white">
      <View className="flex-1 px-6 pt-8">
        <Text className="mb-2 text-3xl font-bold text-neutral-900">
          Bonjour {user.firstName} 👋
        </Text>
        <Text className="mb-1 text-sm text-neutral-600">
          Connecté en tant que <Text className="font-semibold text-brand-700">{user.role}</Text>
        </Text>
        <Text className="mb-6 text-xs text-neutral-500">
          (rôles disponibles — CLIENT : {String(roles.client)} · PRESTATAIRE :{' '}
          {String(roles.prestataire)})
        </Text>

        <View className="mb-6 rounded-2xl bg-neutral-50 p-4">
          <Text className="text-xs uppercase text-neutral-500">Email</Text>
          <Text className="text-base text-neutral-900">{user.email}</Text>
        </View>

        <View className="flex-1" />

        <Pressable
          onPress={() => {
            void logout()
          }}
          disabled={pending.logout}
          className={`mb-6 flex-row items-center justify-center rounded-2xl border px-6 py-4 ${
            pending.logout ? 'border-neutral-200' : 'border-neutral-300'
          }`}
        >
          {pending.logout ? (
            <ActivityIndicator color="#737373" />
          ) : (
            <Text className="text-base font-semibold text-neutral-700">Se déconnecter</Text>
          )}
        </Pressable>
      </View>
    </SafeAreaView>
  )
}
