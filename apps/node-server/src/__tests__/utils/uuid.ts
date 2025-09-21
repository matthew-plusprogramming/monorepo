import * as crypto from 'node:crypto';

import type { MockInstance } from 'vitest';
import { vi } from 'vitest';

let randomUuidSpy: MockInstance<typeof crypto.randomUUID> | undefined;

const ensureQueueHasValues = (
  queue: Array<ReturnType<typeof crypto.randomUUID>>,
): ReturnType<typeof crypto.randomUUID> => {
  const value = queue.shift();
  if (!value) {
    throw new Error('No UUID values remaining in mock queue.');
  }
  return value;
};

export const restoreRandomUUID = (): void => {
  randomUuidSpy?.mockRestore();
  randomUuidSpy = undefined;
};

export const mockRandomUUIDSequence = (uuids: ReadonlyArray<string>): void => {
  restoreRandomUUID();
  const queue = [...uuids] as Array<ReturnType<typeof crypto.randomUUID>>;
  randomUuidSpy = vi
    .spyOn(crypto, 'randomUUID')
    .mockImplementation(() => ensureQueueHasValues(queue));
};

export const mockRandomUUID = (uuid: string): void => {
  mockRandomUUIDSequence([uuid]);
};

export const isRandomUUIDMocked = (): boolean => randomUuidSpy !== undefined;
