import { z } from 'zod';

export const USER_PASSWORD_MIN_LENGTH = 8;
export const USER_USERNAME_MIN_LENGTH = 1;
// ! Consider using a more restrictive email policy
export const UserIdSchema = z.uuid().meta({
  description: 'User identifier',
});
export const UserEmailSchema = z
  .email()
  .meta({ description: 'User email address' });
export const UserPlaintextPasswordSchema = z
  .string()
  .min(USER_PASSWORD_MIN_LENGTH)
  .meta({
    description: 'User password',
  });
export const UserPasswordHashSchema = z.string().meta({
  description: 'User password hash',
});
export const UserUsernameSchema = z
  .string()
  .min(USER_USERNAME_MIN_LENGTH)
  .meta({
    description: 'User username',
  });

export const UserSchema = z.object({
  id: UserIdSchema,
  username: UserUsernameSchema,
  email: UserEmailSchema,
  passwordHash: UserPasswordHashSchema,
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
