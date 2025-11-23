import { z } from 'zod';

import { USER_SCHEMA_CONSTANTS } from '../constants/index.js';

export const UserIdSchema = z.uuid().meta({
  description: 'User identifier',
});

// ! Consider using a more restrictive email policy
export const UserEmailSchema = z
  .email()
  .meta({ description: 'User email address' });

export const UserFullNameSchema = z
  .string()
  .min(USER_SCHEMA_CONSTANTS.fullName.minLength)
  .meta({ description: 'User full name' });

export const UserPlaintextPasswordSchema = z
  .string()
  .min(USER_SCHEMA_CONSTANTS.password.minLength)
  .meta({
    description: 'User password',
  });

export const UserPasswordHashSchema = z.string().meta({
  description: 'User password hash',
});

export const UserUsernameSchema = z
  .string()
  .min(USER_SCHEMA_CONSTANTS.username.minLength)
  .meta({
    description: 'User username',
  });
