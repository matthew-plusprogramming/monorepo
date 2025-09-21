import { InternalServerError } from '@packages/backend-core';
import { Effect } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z, ZodError } from 'zod';

import { parseInput } from '@/helpers/zodParser';

describe('parseInput', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns parsed value when schema succeeds', async () => {
    const schema = z.object({ id: z.string() });

    const result = await Effect.runPromise(parseInput(schema, { id: '123' }));

    expect(result).toStrictEqual({ id: '123' });
  });

  it('fails with ZodError when schema rejects input', async () => {
    const schema = z.object({ id: z.string() });

    const outcome = await Effect.runPromise(
      Effect.either(parseInput(schema, { id: 123 })),
    );

    expect(outcome._tag).toBe('Left');
    if (outcome._tag === 'Left') {
      expect(outcome.left).toBeInstanceOf(ZodError);
    }
  });

  it('wraps unknown errors in InternalServerError', async () => {
    const schema = z.object({ id: z.string() });
    vi.spyOn(schema, 'parse').mockImplementation(() => {
      throw new Error('unexpected failure');
    });

    const outcome = await Effect.runPromise(
      Effect.either(parseInput(schema, {})),
    );

    expect(outcome._tag).toBe('Left');
    if (outcome._tag === 'Left') {
      expect(outcome.left).toBeInstanceOf(InternalServerError);
      expect(outcome.left.message).toBe('unexpected failure');
    }
  });

  it('coerces non-Error throws into InternalServerError', async () => {
    const schema = z.object({ id: z.string() });
    vi.spyOn(schema, 'parse').mockImplementation(() => {
      throw 'boom';
    });

    const outcome = await Effect.runPromise(
      Effect.either(parseInput(schema, {})),
    );

    expect(outcome._tag).toBe('Left');
    if (outcome._tag === 'Left') {
      expect(outcome.left).toBeInstanceOf(InternalServerError);
      expect(outcome.left.message).toBe('An unknown error occurred');
    }
  });
});
