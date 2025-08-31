import { Data } from 'effect';

export type GenericErrorPayload = {
  message: string;
};

export class ParseError extends Data.TaggedError(
  'ParseError',
)<GenericErrorPayload> {}

export * from './http';
export * from './security';
export * from './user';
