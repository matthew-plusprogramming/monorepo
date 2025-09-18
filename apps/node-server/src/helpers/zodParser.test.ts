import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { z, ZodError } from 'zod';

import { parseInput } from '@/helpers/zodParser';

describe('parseInput', () => {
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
});
