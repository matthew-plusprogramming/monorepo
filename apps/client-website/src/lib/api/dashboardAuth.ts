const DEFAULT_API_URL = 'http://localhost:3000';

type DashboardLoginPayload = {
  password: string;
};

type DashboardLoginResponse = {
  success: boolean;
  message: string;
};

type DashboardLogoutResponse = {
  success: boolean;
  message: string;
};

type DashboardSessionResponse = {
  authenticated: boolean;
};

const getApiUrl = (): string =>
  process.env.NEXT_PUBLIC_API_URL ?? DEFAULT_API_URL;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const extractErrorMessage = (payload: unknown): string | null => {
  if (typeof payload === 'string') {
    return payload;
  }

  if (isRecord(payload)) {
    const errorValue = payload.error;
    if (typeof errorValue === 'string') {
      return errorValue;
    }

    const messageValue = payload.message;
    if (typeof messageValue === 'string') {
      return messageValue;
    }
  }

  return null;
};

const tryReadJsonError = async (response: Response): Promise<string | null> => {
  try {
    const data = (await response.clone().json()) as unknown;
    return extractErrorMessage(data);
  } catch {
    return null;
  }
};

const buildErrorMessage = async (response: Response): Promise<string> => {
  const jsonError = await tryReadJsonError(response);

  if (jsonError) {
    return jsonError;
  }

  try {
    const text = await response.text();
    if (text) {
      return text;
    }
  } catch {
    // Ignore text read errors
  }

  return 'Unable to complete request.';
};

/**
 * Dashboard login - password only authentication (AS-009)
 */
export const dashboardLogin = async (
  payload: DashboardLoginPayload,
): Promise<DashboardLoginResponse> => {
  const response = await fetch(`${getApiUrl()}/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    credentials: 'include', // Include cookies for session
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(await buildErrorMessage(response));
  }

  const data = (await response.json()) as DashboardLoginResponse;
  return data;
};

/**
 * Dashboard logout - clears the session cookie (AS-009)
 */
export const dashboardLogout = async (): Promise<DashboardLogoutResponse> => {
  const response = await fetch(`${getApiUrl()}/api/auth/logout`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
    },
    credentials: 'include', // Include cookies for session
  });

  if (!response.ok) {
    throw new Error(await buildErrorMessage(response));
  }

  const data = (await response.json()) as DashboardLogoutResponse;
  return data;
};

/**
 * Check if the current session is valid (AS-009)
 */
export const checkDashboardSession =
  async (): Promise<DashboardSessionResponse> => {
    try {
      const response = await fetch(`${getApiUrl()}/api/auth/session`, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
        credentials: 'include', // Include cookies for session
      });

      if (!response.ok) {
        return { authenticated: false };
      }

      const data = (await response.json()) as DashboardSessionResponse;
      return data;
    } catch {
      // Network error or other failure
      return { authenticated: false };
    }
  };

export type {
  DashboardLoginPayload,
  DashboardLoginResponse,
  DashboardLogoutResponse,
  DashboardSessionResponse,
};
