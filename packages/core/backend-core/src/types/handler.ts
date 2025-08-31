import type { Effect } from 'effect';
import type { Request } from 'express';

export type handlerInput = Effect.Effect<Request, never, never>;
