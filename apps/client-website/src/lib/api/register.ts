const DEFAULT_API_URL = 'http://localhost:3000';

type RegisterPayload = {
  name: string;
  username: string;
  email: string;
  password: string;
};

const getApiUrl = (): string =>
  process.env.NEXT_PUBLIC_API_URL ?? DEFAULT_API_URL;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const extractMessageFromJson = (payload: unknown): string | null => {
  if (typeof payload === 'string') {
    return payload;
  }

  if (isRecord(payload)) {
    const messageValue = payload.message;

    if (typeof messageValue === 'string') {
      return messageValue;
    }

    const errorValue = payload.error;

    if (typeof errorValue === 'string') {
      return errorValue;
    }
  }

  return null;
};

const tryReadJsonMessage = async (
  response: Response,
): Promise<string | null> => {
  try {
    const data = (await response.clone().json()) as unknown;
    return extractMessageFromJson(data);
  } catch {
    return null;
  }
};

const tryReadTextMessage = async (
  response: Response,
): Promise<string | null> => {
  try {
    const text = await response.text();
    return text || null;
  } catch {
    return null;
  }
};

const buildErrorMessage = async (response: Response): Promise<string> => {
  const jsonMessage = await tryReadJsonMessage(response);

  if (jsonMessage) {
    return jsonMessage;
  }

  const textMessage = await tryReadTextMessage(response);
  if (textMessage) {
    return textMessage;
  }

  return 'Unable to complete registration request.';
};

export const register = async (payload: RegisterPayload): Promise<string> => {
  const response = await fetch(`${getApiUrl()}/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/plain',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(await buildErrorMessage(response));
  }

  const token = await response.text();

  if (!token) {
    throw new Error('Registration succeeded but returned an empty token.');
  }

  return token;
};

export type { RegisterPayload };
