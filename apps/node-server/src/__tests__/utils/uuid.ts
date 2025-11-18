import { vi } from 'vitest';

type RandomUuidState = {
  queue: Array<string>;
  isMockActive: boolean;
  mock?: ReturnType<typeof vi.fn>;
  actualRandomUUID?: () => string;
};

const randomUuidState = vi.hoisted<RandomUuidState>(() => ({
  queue: [],
  isMockActive: false,
  mock: undefined,
  actualRandomUUID: undefined,
}));

vi.mock('node:crypto', async () => {
  const actual =
    (await vi.importActual<typeof import('node:crypto')>('node:crypto'));

  const randomUUID = vi.fn(() => {
    if (!randomUuidState.isMockActive) {
      return actual.randomUUID();
    }

    const value = randomUuidState.queue.shift();
    if (!value) {
      throw new Error('No UUID values remaining in mock queue.');
    }
    return value;
  });

  randomUuidState.mock = randomUUID;
  randomUuidState.actualRandomUUID = actual.randomUUID;

  return {
    ...actual,
    randomUUID,
  };
});

export const restoreRandomUUID = (): void => {
  randomUuidState.queue = [];
  randomUuidState.isMockActive = false;
  randomUuidState.mock?.mockClear();
};

export const mockRandomUUIDSequence = (uuids: ReadonlyArray<string>): void => {
  randomUuidState.queue = [...uuids];
  randomUuidState.isMockActive = true;
};

export const mockRandomUUID = (uuid: string): void => {
  mockRandomUUIDSequence([uuid]);
};

export const isRandomUUIDMocked = (): boolean => randomUuidState.isMockActive;
