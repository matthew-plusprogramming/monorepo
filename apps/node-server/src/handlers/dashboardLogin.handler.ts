import bcrypt from 'bcryptjs';

import {
  generateRequestHandler,
  type handlerInput,
  HTTP_RESPONSE,
  InternalServerError,
  UserInvalidCredentialsError,
} from '@packages/backend-core';
import { Effect } from 'effect';
import z, { ZodError } from 'zod';

import { parseInput } from '@/helpers/zodParser';
import { resetRateLimit } from '@/middleware/dashboardRateLimiting.middleware';
import {
  createSessionToken,
  getSessionCookieOptions,
  SESSION_COOKIE_NAME,
} from '@/middleware/dashboardSession.middleware';

// Input schema for dashboard login (password only)
const DashboardLoginInputSchema = z.object({
  password: z.string().min(1, 'Password is required'),
});

const parseDashboardLoginInput = (
  body: unknown,
): Effect.Effect<
  z.infer<typeof DashboardLoginInputSchema>,
  InternalServerError | ZodError
> => parseInput<typeof DashboardLoginInputSchema>(DashboardLoginInputSchema, body);

/**
 * Verifies the dashboard password against the stored bcrypt hash.
 */
const verifyDashboardPassword = (
  password: string,
  passwordHash: string,
): Effect.Effect<boolean, InternalServerError> =>
  Effect.tryPromise({
    try: () => bcrypt.compare(password, passwordHash),
    catch: (error) =>
      new InternalServerError({
        message:
          error instanceof Error
            ? `Failed to verify password: ${error.message}`
            : 'Failed to verify password',
        cause: error,
      }),
  });

type DashboardLoginResponse = {
  success: boolean;
  message: string;
};

const dashboardLoginHandler = (
  input: handlerInput,
): Effect.Effect<
  DashboardLoginResponse,
  InternalServerError | UserInvalidCredentialsError | ZodError
> => {
  return Effect.gen(function* () {
    const req = yield* input;
    const res = req.res;

    if (!res) {
      return yield* new InternalServerError({
        message: 'Response object not available',
        cause: undefined,
      });
    }

    const parsedInput = yield* parseDashboardLoginInput(req.body);

    const passwordHash = process.env.PASSWORD_HASH;
    if (!passwordHash) {
      return yield* new InternalServerError({
        message: 'Password hash not configured',
        cause: undefined,
      });
    }

    const passwordMatches = yield* verifyDashboardPassword(
      parsedInput.password,
      passwordHash,
    );

    if (!passwordMatches) {
      return yield* new UserInvalidCredentialsError({
        message: 'Invalid password',
        cause: undefined,
      });
    }

    // Create session token and set cookie
    const sessionSecret = process.env.SESSION_SECRET;
    const sessionExpiryHours = parseInt(
      process.env.SESSION_EXPIRY_HOURS ?? '24',
      10,
    );

    const sessionToken = createSessionToken(sessionSecret);
    const cookieOptions = getSessionCookieOptions(sessionExpiryHours);

    res.cookie(SESSION_COOKIE_NAME, sessionToken, cookieOptions);

    // Reset rate limiting on successful login
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    resetRateLimit(ip);

    return {
      success: true,
      message: 'Login successful',
    };
  });
};

export const dashboardLoginRequestHandler = generateRequestHandler<
  DashboardLoginResponse,
  InternalServerError | UserInvalidCredentialsError | ZodError
>({
  effectfulHandler: (input) => dashboardLoginHandler(input),
  shouldObfuscate: () => false,
  statusCodesToErrors: {
    [HTTP_RESPONSE.BAD_REQUEST]: {
      errorType: ZodError,
      mapper: (e) => ({ error: z.prettifyError(e as ZodError) }),
    },
    [HTTP_RESPONSE.UNAUTHORIZED]: {
      errorType: UserInvalidCredentialsError,
      mapper: (e) => ({ error: e.message }),
    },
    [HTTP_RESPONSE.INTERNAL_SERVER_ERROR]: {
      errorType: InternalServerError,
      mapper: (e) => ({ error: e.message }),
    },
  },
  successCode: HTTP_RESPONSE.OK,
});
