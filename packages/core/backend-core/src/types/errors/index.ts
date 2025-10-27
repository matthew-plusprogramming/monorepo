import { Data } from 'effect';

export type GenericErrorPayload = {
  message: string;
  cause: unknown;
};

export class ParseError extends Data.TaggedError(
  'ParseError',
)<GenericErrorPayload> {}

export * from '@/types/errors/http.js';
export * from '@/types/errors/security.js';
export * from '@/types/errors/user.js';
