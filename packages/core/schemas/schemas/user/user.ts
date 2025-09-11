import { z } from 'zod';
import {
  UserEmailSchema,
  UserIdSchema,
  UserPasswordHashSchema,
  UserUsernameSchema,
} from './components/index.js';

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

export const UserPublicSchema = z.object({
  id: UserIdSchema,
  username: UserUsernameSchema,
  email: UserEmailSchema,
});

export type UserPublic = z.infer<typeof UserPublicSchema>;
