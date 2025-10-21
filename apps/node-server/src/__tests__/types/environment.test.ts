import { describe, expect, it } from 'vitest';

import { EnvironmentSchema } from '@/types/environment';

describe('EnvironmentSchema', () => {
  const baseEnv = {
    AWS_ACCESS_KEY_ID: 'key',
    AWS_SECRET_ACCESS_KEY: 'secret',
    AWS_REGION: 'us-east-1',
    PEPPER: 'pepper',
    PORT: '3000',
    JWT_SECRET: 'jwt-secret',
  } as const;

  it('parses valid environment variables and coerces PORT to a number', () => {
    // Arrange
    const result = EnvironmentSchema.safeParse(baseEnv);

    // Act
    // Synchronous parse is already executed during arrangement

    // Assert
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toStrictEqual({
        ...baseEnv,
        PORT: 3000,
        APP_ENV: 'development',
        APP_VERSION: '0.0.0',
      });
    }
  });

  it.each([
    ['AWS_ACCESS_KEY_ID', 'AWS_ACCESS_KEY_ID is required'],
    ['AWS_SECRET_ACCESS_KEY', 'AWS_SECRET_ACCESS_KEY is required'],
    ['AWS_REGION', 'AWS_REGION is required'],
    ['PEPPER', 'PEPPER is required'],
    ['PORT', 'Invalid input: expected number, received NaN'],
    ['JWT_SECRET', 'JWT_SECRET is required'],
  ] as const)('fails when %s is missing', (missingKey, expectedMessage) => {
    // Arrange
    const input: Record<string, unknown> = { ...baseEnv };
    delete input[missingKey];

    // Act
    const result = EnvironmentSchema.safeParse(input);

    // Assert
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find(
        (candidate) => candidate.path[0] === missingKey,
      );
      expect(issue).toBeDefined();
      expect(issue?.message).toBe(expectedMessage);
    }
  });

  it('enforces PORT to be a positive number', () => {
    // Arrange
    const result = EnvironmentSchema.safeParse({
      ...baseEnv,
      PORT: '0',
    });

    // Act
    // Safe parse executed during arrangement

    // Assert
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]).toMatchObject({
        path: ['PORT'],
        message: 'PORT must be a positive number',
      });
    }
  });
});
