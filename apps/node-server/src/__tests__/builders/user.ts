import type { UserCreate, UserPublic, UserToken } from '@packages/schemas/user';

const DEFAULT_USER_ID = '11111111-1111-1111-1111-111111111111';
const DEFAULT_NAME = 'Test User';
const DEFAULT_USERNAME = 'test-user';
const DEFAULT_EMAIL = 'test-user@example.com';
const DEFAULT_PASSWORD_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$ZGVmYXVsdC1zYWx0$ZGVmYXVsdC1oYXNo';
const DEFAULT_TOKEN_TIME_SECONDS = 1_704_576_000; // 2024-01-01T00:00:00.000Z

const createUserPublicDefaults = (): UserPublic => ({
  id: DEFAULT_USER_ID,
  name: DEFAULT_NAME,
  username: DEFAULT_USERNAME,
  email: DEFAULT_EMAIL,
});

const createUserCreateDefaults = (): UserCreate => ({
  id: DEFAULT_USER_ID,
  name: DEFAULT_NAME,
  username: DEFAULT_USERNAME,
  email: DEFAULT_EMAIL,
  passwordHash: DEFAULT_PASSWORD_HASH,
});

const createUserTokenDefaults = (): UserToken => ({
  iss: 'https://example.com',
  sub: DEFAULT_USER_ID,
  aud: '22222222-2222-2222-2222-222222222222',
  exp: DEFAULT_TOKEN_TIME_SECONDS + 3_600,
  iat: DEFAULT_TOKEN_TIME_SECONDS,
  jti: '33333333-3333-3333-3333-333333333333',
  role: 'user',
});

export const buildUserPublic = (
  overrides: Partial<UserPublic> = {},
): UserPublic => ({
  ...createUserPublicDefaults(),
  ...overrides,
});

export const buildUserCreate = (
  overrides: Partial<UserCreate> = {},
): UserCreate => ({
  ...createUserCreateDefaults(),
  ...overrides,
});

export const buildUserTokenPayload = (
  overrides: Partial<UserToken> = {},
): UserToken => ({
  ...createUserTokenDefaults(),
  ...overrides,
});
