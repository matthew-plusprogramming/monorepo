import { Effect } from 'effect';
import type { SignOptions } from 'jsonwebtoken';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from 'vitest';

import { mockRandomUUID, restoreRandomUUID } from '@/__tests__/utils/uuid';
import { buildUserToken, signToken } from '@/helpers/token';

const jsonWebTokenModule = vi.hoisted(() => ({
  sign: vi.fn<JWTSignFunction>(),
}));

vi.mock('jsonwebtoken', () => jsonWebTokenModule);

type SignCallback = (err: Error | null, encoded?: string) => void;
type JWTSignFunction = (
  payload: string | object | Buffer,
  secret: string,
  options?: SignOptions,
  callback?: SignCallback,
) => void;
type JWTSignMock = Mock<JWTSignFunction>;

const getSignMock = (): JWTSignMock => {
  const mock = jsonWebTokenModule.sign;
  if (!mock) {
    throw new Error('JWT sign mock was not initialized');
  }
  return mock;
};

describe('token helpers', () => {
  beforeEach(() => {
    getSignMock().mockReset();
    restoreRandomUUID();
    vi.stubEnv('JWT_SECRET', 'test-secret');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    restoreRandomUUID();
  });

  it('builds a user token with deterministic identifiers when UUID is mocked', () => {
    // Arrange
    mockRandomUUID('token-uuid');

    // Act
    const token = buildUserToken('user-123');

    // Assert
    expect(token).toMatchObject({
      sub: 'user-123',
      jti: 'token-uuid',
    });
    expect(typeof token.exp).toBe('number');
    expect(typeof token.iat).toBe('number');
    expect(token.exp - token.iat).toBe(60 * 60);
  });

  it('rejects when JWT signing callback provides no token', async () => {
    // Arrange
    const payload = buildUserToken('user-456');
    getSignMock().mockImplementation(
      (_payload, _secret, _options, callback) => {
        if (callback) callback(null, undefined);
      },
    );

    // Act
    const action = Effect.runPromise(signToken(payload));

    // Assert
    await expect(action).rejects.toHaveProperty(
      'message',
      'Failed to sign JWT: No token returned',
    );
  });

  it('rejects when JWT signing throws a non-Error value', async () => {
    // Arrange
    const payload = buildUserToken('user-789');
    getSignMock().mockImplementation(() => {
      throw 'sign exploded';
    });

    // Act
    const action = Effect.runPromise(signToken(payload));

    // Assert
    await expect(action).rejects.toHaveProperty(
      'message',
      'Failed to sign JWT',
    );
  });
});
