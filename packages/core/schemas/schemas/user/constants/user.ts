export const USER_SCHEMA_CONSTANTS = {
  key: {
    id: 'id',
    email: 'email',
    username: 'username',
  },
  gsi: {
    email: 'email-index',
    username: 'username-index',
  },
  projection: {
    userPublic: 'id, fullName, username, email',
    userCredentials: 'id, fullName, username, email, passwordHash',
  },
  fullName: {
    minLength: 2,
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
