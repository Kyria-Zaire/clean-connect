import { SetMetadata } from '@nestjs/common'

import { IS_PUBLIC_METADATA_KEY } from '../auth.constants'

/** Marque un endpoint comme accessible sans access JWT (bypass du JwtAccessGuard). */
export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_PUBLIC_METADATA_KEY, true)
