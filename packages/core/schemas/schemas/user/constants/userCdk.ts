import { USER_SCHEMA_CONSTANTS } from './user.js';

const UserTableKeys = [
  USER_SCHEMA_CONSTANTS.key.id,
  USER_SCHEMA_CONSTANTS.gsi.email,
] as const;

export type UserTableKey = (typeof UserTableKeys)[number];
