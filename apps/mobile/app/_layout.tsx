import '../global.css'

import { QueryClientProvider } from '@tanstack/react-query'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { ActivityIndicator, Text, View } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'

import { useAuthBootstrap, useAuthStatus } from '../src/features/auth'
import { queryClient } from '../src/lib/query/client'

export default function RootLayout(): JSX.Element {
  useAuthBootstrap()
  const status = useAuthStatus()

  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <StatusBar style="dark" />
        {status === 'restoring' ? <AuthRestoringScreen /> : null}
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: '#ffffff' },
          }}
        />
      </QueryClientProvider>
    </SafeAreaProvider>
  )
}

function AuthRestoringScreen(): JSX.Element {
  return (
    <View
      className="absolute inset-0 z-50 items-center justify-center bg-white"
      accessibilityRole="progressbar"
      accessibilityLabel="Restauration de la session"
    >
      <ActivityIndicator color="#22c55e" size="large" />
      <Text className="mt-3 text-sm text-neutral-600">Restauration de la session…</Text>
    </View>
  )
}
