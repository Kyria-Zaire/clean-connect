import { Controller, type Control, type FieldPath, type FieldValues } from 'react-hook-form'
import { Text, TextInput, View, type TextInputProps } from 'react-native'

interface AuthFormFieldProps<TForm extends FieldValues> extends Omit<TextInputProps, 'value' | 'onChangeText'> {
  control: Control<TForm>
  name: FieldPath<TForm>
  label: string
  error?: string | undefined
}

export function AuthFormField<TForm extends FieldValues>(
  props: AuthFormFieldProps<TForm>,
): JSX.Element {
  const { control, name, label, error, ...inputProps } = props
  return (
    <View className="mb-4">
      <Text className="mb-1 text-sm font-medium text-neutral-700">{label}</Text>
      <Controller
        control={control}
        name={name}
        render={({ field }) => (
          <TextInput
            {...inputProps}
            value={(field.value as string | undefined) ?? ''}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            className="rounded-xl border border-neutral-200 bg-white px-4 py-3 text-base text-neutral-900"
            placeholderTextColor="#a3a3a3"
            autoCapitalize={inputProps.autoCapitalize ?? 'none'}
          />
        )}
      />
      {error ? <Text className="mt-1 text-xs text-danger">{error}</Text> : null}
    </View>
  )
}
