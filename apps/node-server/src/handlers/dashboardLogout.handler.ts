import {
  generateRequestHandler,
  type handlerInput,
  HTTP_RESPONSE,
  InternalServerError,
} from '@packages/backend-core';
import { Effect } from 'effect';

import { SESSION_COOKIE_NAME } from '@/middleware/dashboardSession.middleware';

type DashboardLogoutResponse = {
  success: boolean;
  message: string;
};

const dashboardLogoutHandler = (
  input: handlerInput,
): Effect.Effect<DashboardLogoutResponse, InternalServerError> => {
  return Effect.gen(function* () {
    const req = yield* input;
    const res = req.res;

    if (!res) {
      return yield* new InternalServerError({
        message: 'Response object not available',
        cause: undefined,
      });
    }

    // Clear the session cookie
    res.clearCookie(SESSION_COOKIE_NAME, {
      httpOnly: true,
      secure: process.env.APP_ENV !== 'development',
      sameSite: 'strict',
      path: '/',
    });

    return {
      success: true,
      message: 'Logged out successfully',
    };
  });
};

export const dashboardLogoutRequestHandler = generateRequestHandler<
  DashboardLogoutResponse,
  InternalServerError
>({
  effectfulHandler: (input) => dashboardLogoutHandler(input),
  shouldObfuscate: () => false,
  statusCodesToErrors: {
    [HTTP_RESPONSE.INTERNAL_SERVER_ERROR]: {
      errorType: InternalServerError,
      mapper: (e) => ({ error: e.message }),
    },
  },
  successCode: HTTP_RESPONSE.OK,
});
