import { zodResolver } from '@hookform/resolvers/zod'
import { Link } from 'expo-router'
import { useForm } from 'react-hook-form'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

import { useAuthError, useAuthPending } from '../hooks'
import { useAuthStore } from '../store/auth.store'

import { AuthFormField } from './AuthFormField'
import { loginFormSchema, type LoginFormValues } from './login.schema'

const DEFAULTS: LoginFormValues = { email: '', password: '' }

export function LoginScreen(): JSX.Element {
  const login = useAuthStore((s) => s.login)
  const pending = useAuthPending()
  const lastError = useAuthError()

  const {
    control,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginFormValues>({
    resolver: zodResolver(loginFormSchema),
    defaultValues: DEFAULTS,
    mode: 'onSubmit',
  })

  const onSubmit = handleSubmit(async (values) => {
    await login(values)
  })

  return (
    <SafeAreaView className="flex-1 bg-white">
      <View className="flex-1 px-6 pt-8">
        <Text className="mb-2 text-3xl font-bold text-neutral-900">Connexion</Text>
        <Text className="mb-6 text-sm text-neutral-600">
          Accédez à votre espace Clean Connect.
        </Text>

        <AuthFormField
          control={control}
          name="email"
          label="Email"
          keyboardType="email-address"
          autoComplete="email"
          textContentType="username"
          placeholder="vous@exemple.fr"
          error={errors.email?.message}
        />

        <AuthFormField
          control={control}
          name="password"
          label="Mot de passe"
          secureTextEntry
          autoComplete="password"
          textContentType="password"
          placeholder="••••••••"
          error={errors.password?.message}
        />

        {lastError ? (
          <View className="mb-4 rounded-xl bg-red-50 px-4 py-3">
            <Text className="text-sm text-danger">{lastError.message}</Text>
          </View>
        ) : null}

        <Pressable
          onPress={onSubmit}
          disabled={pending.login}
          className={`flex-row items-center justify-center rounded-2xl px-6 py-4 ${
            pending.login ? 'bg-brand-300' : 'bg-brand'
          }`}
        >
          {pending.login ? (
            <ActivityIndicator color="#ffffff" />
          ) : (
            <Text className="text-base font-semibold text-white">Se connecter</Text>
          )}
        </Pressable>

        <View className="mt-6 flex-row justify-center">
          <Text className="text-sm text-neutral-600">Pas encore de compte ? </Text>
          <Link href="/(auth)/signup" className="text-sm font-semibold text-brand">
            Créer un compte
          </Link>
        </View>
      </View>
    </SafeAreaView>
  )
}
