export const USER_SCHEMA_CONSTANTS = {
  key: {
    id: 'id',
    email: 'email',
  },
  gsi: {
    email: 'email-index',
  },
  projection: {
    userPublic: 'id, username, email',
    userCredentials: 'id, username, email, passwordHash',
  },
  username: {
    minLength: 1,
  },
  password: {
    minLength: 8,
  },
} as const;

export const VERIFICATION_SCHEMA_CONSTANTS = {
  key: {
    id: 'id',
  },
} as const;
