import { zodResolver } from '@hookform/resolvers/zod'
import { Link } from 'expo-router'
import { Controller, useForm } from 'react-hook-form'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

import { useAuthError, useAuthPending } from '../hooks'
import { useAuthStore } from '../store/auth.store'

import { AuthFormField } from './AuthFormField'
import { signupFormSchema, type SignupFormValues } from './login.schema'

const DEFAULTS: SignupFormValues = {
  email: '',
  password: '',
  role: 'CLIENT',
  firstName: '',
  lastName: '',
}

export function SignupScreen(): JSX.Element {
  const signup = useAuthStore((s) => s.signup)
  const pending = useAuthPending()
  const lastError = useAuthError()

  const {
    control,
    handleSubmit,
    formState: { errors },
  } = useForm<SignupFormValues>({
    resolver: zodResolver(signupFormSchema),
    defaultValues: DEFAULTS,
    mode: 'onSubmit',
  })

  const onSubmit = handleSubmit(async (values) => {
    await signup(values)
  })

  return (
    <SafeAreaView className="flex-1 bg-white">
      <View className="flex-1 px-6 pt-8">
        <Text className="mb-2 text-3xl font-bold text-neutral-900">Créer un compte</Text>
        <Text className="mb-6 text-sm text-neutral-600">
          Choisissez votre profil pour démarrer.
        </Text>

        <Controller
          control={control}
          name="role"
          render={({ field }) => (
            <View className="mb-4 flex-row gap-3">
              {(['CLIENT', 'PRESTATAIRE'] as const).map((role) => {
                const active = field.value === role
                return (
                  <Pressable
                    key={role}
                    onPress={() => field.onChange(role)}
                    className={`flex-1 rounded-2xl border px-4 py-3 ${
                      active ? 'border-brand bg-brand-50' : 'border-neutral-200 bg-white'
                    }`}
                  >
                    <Text
                      className={`text-center text-sm font-semibold ${
                        active ? 'text-brand-700' : 'text-neutral-700'
                      }`}
                    >
                      {role === 'CLIENT' ? 'Je suis client' : 'Je suis prestataire'}
                    </Text>
                  </Pressable>
                )
              })}
            </View>
          )}
        />

        <AuthFormField
          control={control}
          name="firstName"
          label="Prénom"
          autoCapitalize="words"
          placeholder="Alice"
          error={errors.firstName?.message}
        />

        <AuthFormField
          control={control}
          name="lastName"
          label="Nom"
          autoCapitalize="words"
          placeholder="Dupont"
          error={errors.lastName?.message}
        />

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
          label="Mot de passe (12 caractères min.)"
          secureTextEntry
          autoComplete="new-password"
          textContentType="newPassword"
          placeholder="••••••••••••"
          error={errors.password?.message}
        />

        {lastError ? (
          <View className="mb-4 rounded-xl bg-red-50 px-4 py-3">
            <Text className="text-sm text-danger">{lastError.message}</Text>
          </View>
        ) : null}

        <Pressable
          onPress={onSubmit}
          disabled={pending.signup}
          className={`flex-row items-center justify-center rounded-2xl px-6 py-4 ${
            pending.signup ? 'bg-brand-300' : 'bg-brand'
          }`}
        >
          {pending.signup ? (
            <ActivityIndicator color="#ffffff" />
          ) : (
            <Text className="text-base font-semibold text-white">Créer mon compte</Text>
          )}
        </Pressable>

        <View className="mt-6 flex-row justify-center">
          <Text className="text-sm text-neutral-600">Déjà un compte ? </Text>
          <Link href="/(auth)/login" className="text-sm font-semibold text-brand">
            Se connecter
          </Link>
        </View>
      </View>
    </SafeAreaView>
  )
}
