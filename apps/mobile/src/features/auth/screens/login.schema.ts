/**
 * Schémas Zod utilisés par les formulaires React Hook Form du module Auth.
 * On NE réutilise PAS directement les schémas serveur (`@cc/shared-types`)
 * pour le LOGIN : côté client on accepte n'importe quel mot de passe (la
 * vérification finale se fait serveur — pas besoin d'imposer la politique
 * `passwordSchema` du backend ici, sinon on bloque les comptes existants
 * dont le mdp avait été créé avant un éventuel durcissement).
 */

import { authSignUpPublicRoleSchema, emailSchema } from '@cc/shared-types'
import { z } from 'zod'

export const loginFormSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Mot de passe requis.').max(128),
})
export type LoginFormValues = z.infer<typeof loginFormSchema>

export const signupFormSchema = z.object({
  email: emailSchema,
  password: z
    .string()
    .min(12, 'Minimum 12 caractères.')
    .max(128, 'Maximum 128 caractères.'),
  role: authSignUpPublicRoleSchema,
  firstName: z.string().trim().min(1, 'Prénom requis.').max(80),
  lastName: z.string().trim().min(1, 'Nom requis.').max(80),
})
export type SignupFormValues = z.infer<typeof signupFormSchema>
