import { USER_SCHEMA_CONSTANTS } from './user.js';

export const USER_TABLE_KEYS = [
  USER_SCHEMA_CONSTANTS.key.id,
  USER_SCHEMA_CONSTANTS.gsi.email,
  USER_SCHEMA_CONSTANTS.gsi.username,
] as const;

export type UserTableKey = (typeof USER_TABLE_KEYS)[number];
