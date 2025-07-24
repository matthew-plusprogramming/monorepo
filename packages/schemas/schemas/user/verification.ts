import { z } from 'zod';

export const UserVerificationSchema = z.object({
  id: z.uuid().meta({ description: 'Verification identifier' }),
  userId: z.uuid().meta({ description: 'User identifier' }),
  email: z.email().meta({ description: 'User email address' }),
  ttl: z.int().positive().meta({
    description:
      'Time to live for the verification record in seconds (unix epoch timestamp)',
  }),
});

export type UserVerification = z.infer<typeof UserVerificationSchema>;
