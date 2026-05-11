import { Link, Stack } from 'expo-router'
import { Text, View } from 'react-native'

export default function NotFoundScreen(): JSX.Element {
  return (
    <>
      <Stack.Screen options={{ title: 'Oops' }} />
      <View className="flex-1 items-center justify-center bg-white p-5">
        <Text className="mb-4 text-xl font-bold">{"Cette page n'existe pas."}</Text>
        <Link href="/" className="text-base text-brand">
          {"Retour à l'accueil"}
        </Link>
      </View>
    </>
  )
}
