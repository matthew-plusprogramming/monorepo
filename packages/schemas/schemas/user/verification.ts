import { z } from 'zod';
import { UserEmailSchema, UserIdSchema } from './user';

export const UserVerificationSchema = z.object({
  id: z.uuid().meta({ description: 'Verification identifier' }),
  userId: UserIdSchema,
  email: UserEmailSchema,
  ttl: z.int().positive().meta({
    description:
      'Time to live for the verification record in seconds (unix epoch timestamp)',
  }),
});

export type UserVerification = z.infer<typeof UserVerificationSchema>;
