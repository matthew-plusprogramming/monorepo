import { HTTP_RESPONSE, InternalServerError } from '@packages/backend-core';
import {
  JWT_AUDIENCE,
  JWT_ISSUER,
  USER_ROLE,
} from '@packages/backend-core/auth';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserRepoFake } from '@/__tests__/fakes/userRepo';
// no need for value imports; use simple tuple typing instead
import { makeRequestContext } from '@/__tests__/utils/express';
import { withFixedTime } from '@/__tests__/utils/time';
import { restoreRandomUUID } from '@/__tests__/utils/uuid';

// Hoisted state to capture the fake exposed by the AppLayer mock
const userRepoModule = vi.hoisted(() => ({ fake: undefined as unknown }));
const argonModule = vi.hoisted(() => ({ hash: undefined as unknown }));
const jwtModule = vi.hoisted(() => ({ sign: undefined as unknown }));

vi.hoisted(() => {
  (globalThis as typeof globalThis & { __BUNDLED__: boolean }).__BUNDLED__ =
    false;
  return undefined;
});

vi.mock('@/clients/cdkOutputs', () => ({
  usersTableName: 'users-table',
}));

vi.mock('@/layers/app.layer', async () => {
  const { createUserRepoFake } = await import('@/__tests__/fakes/userRepo');
  const fake = createUserRepoFake();
  userRepoModule.fake = fake;
  return { AppLayer: fake.layer };
});

vi.mock('@node-rs/argon2', () => {
  const hash = vi.fn();
  argonModule.hash = hash;
  return { default: { hash } };
});

vi.mock('jsonwebtoken', () => {
  const sign = vi.fn();
  jwtModule.sign = sign;
  return { sign };
});

const getUserRepoFake = (): UserRepoFake => userRepoModule.fake as UserRepoFake;
const getHashMock = (): ReturnType<typeof vi.fn> => argonModule.hash as never;
const getSignMock = (): ReturnType<typeof vi.fn> => jwtModule.sign as never;

type RegisterTestContext = ReturnType<typeof makeRequestContext>;
type RegisterHandler = (
  req: RegisterTestContext['req'],
  res: RegisterTestContext['res'],
  next: RegisterTestContext['next'],
) => Promise<void> | void;

async function importRegisterHandler(): Promise<RegisterHandler> {
  const module = await import('@/handlers/register.handler');
  return module.registerRequestHandler as unknown as RegisterHandler;
}

function initializeRegisterContext(): void {
  vi.resetModules();
  restoreRandomUUID();
  process.env.PEPPER = 'test-pepper';
  process.env.JWT_SECRET = 'shh-its-a-secret';
}

async function returns201ForNewUser(): Promise<void> {
  const body = createRegisterBody({
    username: 'new-user',
    email: 'new-user@example.com',
  });
  const { req, res, captured } = makeRequestContext({
    method: 'POST',
    url: '/register',
    body,
  });

  await withFixedTime('2024-01-01T00:00:00.000Z', async () => {
    const handler = await importRegisterHandler();
    prepareSuccessfulRegistration('hashed-password', 'signed.token.value');
    await handler(req, res, vi.fn());
  });

  assertSuccessfulRegistration({
    body,
    captured,
    expectedToken: 'signed.token.value',
    issuedAtIso: '2024-01-01T00:00:00.000Z',
  });
}

async function obfuscatesConflictAs502(): Promise<void> {
  const body = createRegisterBody({
    username: 'dup',
    email: 'dup@example.com',
  });
  const { req, res, captured } = makeRequestContext({
    method: 'POST',
    url: '/register',
    body,
  });
  const handler = await importRegisterHandler();

  const repoFake = resetUserRepoFake();
  repoFake.queueFindSome({
    id: '11111111-1111-1111-1111-111111111111',
    username: 'dup',
    email: 'dup@example.com',
  });
  await handler(req, res, vi.fn());

  expect(captured.statusCode).toBe(HTTP_RESPONSE.BAD_GATEWAY);
  expect(captured.sendBody).toBe('Bad Gateway');
}

async function propagatesRepoCreateFailure(): Promise<void> {
  const handler = await importRegisterHandler();
  getHashMock().mockResolvedValueOnce('hashed-password');

  const { req, res, captured } = makeRequestContext({
    method: 'POST',
    url: '/register',
    body: createRegisterBody({ username: 'user', email: 'user@example.com' }),
  });

  const repoFake = resetUserRepoFake();
  repoFake.queueFindNone();
  repoFake.queueCreateFailure(
    new InternalServerError({ message: 'ddb put failed' }),
  );
  await handler(req, res, vi.fn());

  expect(captured.statusCode).toBe(HTTP_RESPONSE.INTERNAL_SERVER_ERROR);
  expect(captured.sendBody).toBe('ddb put failed');
}

async function rejectsWhenHashingFails(): Promise<void> {
  getHashMock().mockRejectedValueOnce(new Error('argon2 failed'));

  const { req, res } = makeRequestContext({
    method: 'POST',
    url: '/register',
    body: createRegisterBody({ username: 'user', email: 'user@example.com' }),
  });

  const handler = await importRegisterHandler();
  const repoFake = resetUserRepoFake();
  repoFake.queueFindNone();

  await expect(handler(req, res, vi.fn())).rejects.toBeDefined();
}

async function rejectsWhenJwtFails(): Promise<void> {
  const handler = await importRegisterHandler();
  getHashMock().mockResolvedValueOnce('hashed-password');
  getSignMock().mockImplementationOnce(() => {
    throw new Error('jwt sign failed');
  });

  const { req, res } = makeRequestContext({
    method: 'POST',
    url: '/register',
    body: createRegisterBody({ username: 'user', email: 'user@example.com' }),
  });

  await withFixedTime('2024-01-01T00:00:00.000Z', async () => {
    const repoFake = resetUserRepoFake();
    repoFake.queueFindNone();
    repoFake.queueCreateSuccess();
    await expect(handler(req, res, vi.fn())).rejects.toBeDefined();
  });
}

function createRegisterBody({
  username,
  email,
  password = 'supersecret',
}: {
  username: string;
  email: string;
  password?: string;
}): { username: string; email: string; password: string } {
  return { username, email, password };
}

function resetUserRepoFake(): UserRepoFake {
  const fake = getUserRepoFake();
  fake.reset();
  return fake;
}

function prepareSuccessfulRegistration(
  hashResult: string,
  tokenResult: string,
): void {
  getHashMock().mockResolvedValueOnce(hashResult);
  getSignMock().mockReturnValueOnce(tokenResult);
  const repoFake = resetUserRepoFake();
  repoFake.queueFindNone();
  repoFake.queueCreateSuccess();
}

function assertSuccessfulRegistration({
  body,
  captured,
  expectedToken,
  issuedAtIso,
}: {
  body: { username: string; email: string; password: string };
  captured: RegisterTestContext['captured'];
  expectedToken: string;
  issuedAtIso: string;
}): void {
  expect(captured.statusCode).toBe(HTTP_RESPONSE.CREATED);
  expect(captured.sendBody).toBe(expectedToken);

  const signCall = getSignMock().mock.calls[0] as
    | [Record<string, unknown>, string]
    | undefined;
  expect(signCall).toBeDefined();
  if (!signCall) {
    throw new Error('JWT sign call missing');
  }
  const [payload, secret] = signCall;
  expect(secret).toBe('shh-its-a-secret');

  const issuedAtMillis = Date.parse(issuedAtIso);
  const expectedIssuedAtSeconds = issuedAtMillis / 1000;
  const expectedExpiresAtSeconds = expectedIssuedAtSeconds + 60 * 60;

  expect(payload).toMatchObject({
    iss: JWT_ISSUER,
    aud: JWT_AUDIENCE,
    exp: expectedExpiresAtSeconds,
    iat: expectedIssuedAtSeconds,
    role: USER_ROLE,
  });
  expect(typeof payload.sub).toBe('string');
  expect(typeof payload.jti).toBe('string');
  expect((payload.jti as string).length).toBeGreaterThan(0);

  const createCall = getUserRepoFake().calls.create[0];
  expect(createCall).toBeDefined();
  const ensuredCreateCall = createCall!;
  expect(ensuredCreateCall).toMatchObject({
    username: body.username,
    email: body.email,
    passwordHash: 'hashed-password',
  });
  expect(ensuredCreateCall.id).toBe(payload.sub as string);
}
describe('registerRequestHandler', () => {
  beforeEach(initializeRegisterContext);

  it('returns 201 and a token for a new user', returns201ForNewUser);
  it(
    'obfuscates conflict as 502 when user already exists',
    obfuscatesConflictAs502,
  );
  it(
    'propagates repo create failure via InternalServerError (obfuscated 502)',
    propagatesRepoCreateFailure,
  );
  it('rejects when hashing throws an unknown error', rejectsWhenHashingFails);
  it('rejects when JWT signing throws an unknown error', rejectsWhenJwtFails);
});
