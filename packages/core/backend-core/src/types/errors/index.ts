import { Data } from 'effect';

export type GenericErrorPayload = {
  message: string;
};

export class ParseError extends Data.TaggedError(
  'ParseError',
)<GenericErrorPayload> {}

export * from './http.js';
export * from './security.js';
export * from './user.js';
