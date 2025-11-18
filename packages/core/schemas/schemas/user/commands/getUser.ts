import { z } from 'zod';

import {
  UserEmailSchema,
  UserIdSchema,
  UserUsernameSchema,
} from '../components/index.js';

export const GetUserSchema = z
  .union([UserIdSchema, UserEmailSchema, UserUsernameSchema])
  .meta({
    description: 'User identifier, can be either id, email, or username',
  });

export type GetUserInput = z.infer<typeof GetUserSchema>;
