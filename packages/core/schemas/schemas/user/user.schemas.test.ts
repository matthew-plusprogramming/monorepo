import { describe, expect, it } from 'vitest';

import {
  GetUserSchema,
  RegisterInputSchema,
  UserCreateSchema,
  UserPublicSchema,
  UserTokenSchema,
} from './index.js';

const baseRegisterInput = {
  username: 'new-user',
  email: 'new-user@example.com',
  password: 'supersecret',
} as const;

describe('user schemas', () => {
  it('accepts valid register input and rejects short passwords', () => {
    expect(RegisterInputSchema.parse(baseRegisterInput)).toStrictEqual(
      baseRegisterInput,
    );

    const invalidResult = RegisterInputSchema.safeParse({
      ...baseRegisterInput,
      password: 'short',
    });
    expect(invalidResult.success).toBe(false);
    if (!invalidResult.success) {
      expect(invalidResult.error.issues[0]?.message).toContain(
        'expected string to have >=8 characters',
      );
    }
  });

  it('maps both user id and email via GetUserSchema', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect(GetUserSchema.parse(id)).toBe(id);
    expect(GetUserSchema.parse(baseRegisterInput.email)).toBe(
      baseRegisterInput.email,
    );

    const invalidIdentifier = GetUserSchema.safeParse('not-a-valid-identifier');
    expect(invalidIdentifier.success).toBe(false);
    if (!invalidIdentifier.success) {
      expect(invalidIdentifier.error.issues.length).toBeGreaterThan(0);
      expect(invalidIdentifier.error.issues[0]?.message).toBe('Invalid input');
    }
  });

  it('requires all fields for UserCreateSchema and UserPublicSchema', () => {
    const createInput = {
      id: '11111111-1111-4111-8111-111111111111',
      username: baseRegisterInput.username,
      email: baseRegisterInput.email,
      passwordHash: 'hashed-password',
    } as const;

    expect(UserCreateSchema.parse(createInput)).toStrictEqual(createInput);

    const missingId = UserCreateSchema.safeParse({
      ...createInput,
      id: undefined,
    });
    expect(missingId.success).toBe(false);

    const publicShape = {
      id: createInput.id,
      username: createInput.username,
      email: createInput.email,
    } as const;
    expect(UserPublicSchema.parse(publicShape)).toStrictEqual(publicShape);

    const invalidEmail = UserPublicSchema.safeParse({
      ...publicShape,
      email: 'invalid',
    });
    expect(invalidEmail.success).toBe(false);
  });

  it('validates token claims for UserTokenSchema', () => {
    const token = {
      iss: 'issuer',
      sub: '11111111-1111-4111-8111-111111111111',
      aud: '22222222-2222-4222-8222-222222222222',
      exp: 1_696_272_000,
      iat: 1_696_268_400,
      jti: '33333333-3333-4333-8333-333333333333',
      role: 'user',
    } as const;

    expect(UserTokenSchema.parse(token)).toStrictEqual(token);

    const invalidToken = UserTokenSchema.safeParse({
      ...token,
      role: 7,
    });
    expect(invalidToken.success).toBe(false);
  });
});
