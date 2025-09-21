import { vi } from 'vitest';

type TimeInput = number | string | Date;

let usingFakeTimers = false;

const toDate = (input: TimeInput): Date => {
  if (input instanceof Date) return input;
  if (typeof input === 'number') return new Date(input);
  return new Date(input);
};

export const freezeTime = (input: TimeInput = new Date()): Date => {
  const date = toDate(input);
  if (!usingFakeTimers) {
    vi.useFakeTimers();
    usingFakeTimers = true;
  }
  vi.setSystemTime(date);
  return date;
};

export const resetTime = (): void => {
  if (usingFakeTimers) {
    vi.useRealTimers();
    usingFakeTimers = false;
  }
};

export const withFixedTime = async <R>(
  input: TimeInput,
  run: () => Promise<R> | R,
): Promise<R> => {
  freezeTime(input);
  try {
    return await run();
  } finally {
    resetTime();
  }
};

export const advanceTimeBy = (milliseconds: number): void => {
  if (!usingFakeTimers) {
    throw new Error('advanceTimeBy requires freezeTime to be called first.');
  }
  vi.advanceTimersByTime(milliseconds);
};

export const getSystemTime = (): Date => new Date(Date.now());
