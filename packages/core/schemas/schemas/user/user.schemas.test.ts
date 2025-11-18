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

// Disabled for test file due to length
/* eslint-disable max-lines-per-function */
describe('user schemas', () => {
  it('accepts valid register input and rejects short passwords', () => {
    // Arrange
    const invalidInput = {
      ...baseRegisterInput,
      password: 'short',
    };

    // Act
    const parsed = RegisterInputSchema.parse(baseRegisterInput);
    const invalidResult = RegisterInputSchema.safeParse(invalidInput);

    // Assert
    expect(parsed).toStrictEqual(baseRegisterInput);
    expect(invalidResult.success).toBe(false);
    if (!invalidResult.success) {
      expect(invalidResult.error.issues[0]?.message).toContain(
        'expected string to have >=8 characters',
      );
    }
  });

  it('maps user id, email, and username via GetUserSchema', () => {
    // Arrange
    const id = '11111111-1111-4111-8111-111111111111';

    // Act
    const parsedId = GetUserSchema.parse(id);
    const parsedEmail = GetUserSchema.parse(baseRegisterInput.email);
    const parsedUsername = GetUserSchema.parse(baseRegisterInput.username);
    const invalidIdentifier = GetUserSchema.safeParse('');

    // Assert
    expect(parsedId).toBe(id);
    expect(parsedEmail).toBe(baseRegisterInput.email);
    expect(parsedUsername).toBe(baseRegisterInput.username);
    expect(invalidIdentifier.success).toBe(false);
    if (!invalidIdentifier.success) {
      expect(invalidIdentifier.error.issues.length).toBeGreaterThan(0);
      expect(invalidIdentifier.error.issues[0]?.message).toBe('Invalid input');
    }
  });

  it('requires all fields for UserCreateSchema and UserPublicSchema', () => {
    // Arrange
    const createInput = {
      id: '11111111-1111-4111-8111-111111111111',
      username: baseRegisterInput.username,
      email: baseRegisterInput.email,
      passwordHash: 'hashed-password',
    } as const;
    const publicShape = {
      id: createInput.id,
      username: createInput.username,
      email: createInput.email,
    } as const;

    // Act
    const parsedCreate = UserCreateSchema.parse(createInput);
    const parsedPublic = UserPublicSchema.parse(publicShape);
    const missingId = UserCreateSchema.safeParse({
      ...createInput,
      id: undefined,
    });
    const invalidEmail = UserPublicSchema.safeParse({
      ...publicShape,
      email: 'invalid',
    });

    // Assert
    expect(parsedCreate).toStrictEqual(createInput);
    expect(missingId.success).toBe(false);
    expect(parsedPublic).toStrictEqual(publicShape);
    expect(invalidEmail.success).toBe(false);
  });

  it('validates token claims for UserTokenSchema', () => {
    // Arrange
    const token = {
      iss: 'issuer',
      sub: '11111111-1111-4111-8111-111111111111',
      aud: '22222222-2222-4222-8222-222222222222',
      exp: 1_696_272_000,
      iat: 1_696_268_400,
      jti: '33333333-3333-4333-8333-333333333333',
      role: 'user',
    } as const;

    // Act
    const parsedToken = UserTokenSchema.parse(token);
    const invalidToken = UserTokenSchema.safeParse({
      ...token,
      role: 7,
    });

    // Assert
    expect(parsedToken).toStrictEqual(token);
    expect(invalidToken.success).toBe(false);
  });
});
