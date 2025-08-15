import { z } from 'zod';
import { UserIdSchema } from './user';

export const UserTokenSchema = z.object({
  // Standard claims
  iss: z.string(),
  sub: UserIdSchema,
  aud: z.uuid(),
  exp: z.number(),
  iat: z.number(),
  jti: z.uuid(),

  // Unique claims
  role: z.string(),
});

export type UserToken = z.infer<typeof UserTokenSchema>;
