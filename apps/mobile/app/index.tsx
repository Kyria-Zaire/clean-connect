import { formatEUR } from '@cc/shared-types'
import { Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

export default function Home(): JSX.Element {
  return (
    <SafeAreaView className="flex-1 bg-white">
      <View className="flex-1 items-center justify-center px-6">
        <Text className="mb-2 text-3xl font-bold text-neutral-900">Clean Connect</Text>
        <Text className="mb-6 text-base text-neutral-600">
          Bootstrap mobile OK · Expo + NativeWind + TanStack Query
        </Text>
        <View className="rounded-2xl bg-brand px-6 py-4">
          <Text className="text-base font-semibold text-white">
            Démo commission : {formatEUR(19900)} → commission {formatEUR(3582)}
          </Text>
        </View>
        <Text className="mt-6 text-sm text-neutral-500">
          PRD-001 (auth) à venir · cf. docs/method/BMAD.md
        </Text>
      </View>
    </SafeAreaView>
  )
}
