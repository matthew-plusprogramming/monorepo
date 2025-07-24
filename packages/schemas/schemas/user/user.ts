import { z } from 'zod';

export const UserSchema = z.object({
  id: z.uuid().meta({ description: 'User identifier' }),
  username: z.string().min(1).meta({ description: 'User username' }),
  email: z.email().meta({ description: 'User email address' }),
  passwordHash: z.string().min(1).meta({ description: 'User password hash' }),
  createdAt: z.date().meta({ description: 'User creation timestamp' }),
  updatedAt: z
    .date()
    .optional()
    .meta({ description: 'User last update timestamp' }),
  deletedAt: z
    .date()
    .optional()
    .meta({ description: 'User deletion timestamp' }),
});

export type User = z.infer<typeof UserSchema>;
