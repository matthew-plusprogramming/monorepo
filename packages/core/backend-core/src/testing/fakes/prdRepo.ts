/**
 * PRD Repository Fake
 *
 * A testable fake implementation of the PrdRepository
 * for unit testing components that depend on PRD operations.
 */

import { Effect, Layer, Option } from 'effect';

import { GoogleDocsApiError, PrdConflictError, PrdNotFoundError } from '@/prds/errors.js';
import {
  PrdRepository,
  type PrdRepositorySchema,
} from '@/prds/repository.js';
import {
  PrdSyncStatus,
  type CreatePrdInput,
  type Prd,
  type PrdSyncStatusType,
  type SyncPrdResult,
} from '@/prds/types.js';
import { InternalServerError } from '@/types/errors/http.js';
import { createHash } from 'crypto';

// Re-export PrdRepository for tests that need to reference it
export { PrdRepository };

export type PrdRepositoryFake = {
  readonly service: PrdRepositorySchema;
  readonly layer: Layer.Layer<PrdRepository, never, never>;
  readonly setPrds: (prds: Prd[]) => void;
  readonly getPrds: () => ReadonlyArray<Prd>;
  readonly simulateSyncResult: (
    prdId: string,
    result: SyncPrdResult | GoogleDocsApiError,
  ) => void;
  readonly reset: () => void;
};

export const createPrdRepositoryFake = (): PrdRepositoryFake => {
  const prdsStore: Map<string, Prd> = new Map();
  const syncResults: Map<string, SyncPrdResult | GoogleDocsApiError> = new Map();

  const computeContentHash = (content: string): string => {
    return createHash('sha256').update(content).digest('hex');
  };

  const service: PrdRepositorySchema = {
    getById: (id: string) =>
      Effect.sync(() => {
        const prd = prdsStore.get(id);
        return prd ? Option.some(prd) : Option.none();
      }),

    getAll: () =>
      Effect.sync(() => {
        return Array.from(prdsStore.values());
      }),

    create: (input: CreatePrdInput) =>
      Effect.gen(function* () {
        if (prdsStore.has(input.id)) {
          return yield* new PrdConflictError({
            message: `PRD with id ${input.id} already exists`,
            cause: undefined,
          });
        }

        const now = new Date().toISOString();
        const prd: Prd = {
          id: input.id,
          googleDocId: input.googleDocId,
          title: input.title,
          content: '',
          contentHash: computeContentHash(''),
          version: 0,
          lastSyncedAt: now,
          createdAt: now,
          updatedAt: now,
          createdBy: input.createdBy,
          syncStatus: PrdSyncStatus.NEVER_SYNCED,
        };

        prdsStore.set(input.id, prd);
        return prd;
      }),

    sync: (prdId: string) =>
      Effect.gen(function* () {
        const prd = prdsStore.get(prdId);
        if (!prd) {
          return yield* new PrdNotFoundError({
            message: `PRD with id ${prdId} not found`,
            cause: undefined,
          });
        }

        const simulatedResult = syncResults.get(prdId);
        if (simulatedResult) {
          if (simulatedResult instanceof GoogleDocsApiError) {
            return yield* simulatedResult;
          }
          // Update the store with the synced PRD
          prdsStore.set(prdId, simulatedResult.prd);
          return simulatedResult;
        }

        // Default behavior: no change
        return {
          prd,
          contentChanged: false,
          previousVersion: prd.version,
        };
      }),

    updateSyncStatus: (id: string, status: PrdSyncStatusType, error?: string) =>
      Effect.gen(function* () {
        const prd = prdsStore.get(id);
        if (!prd) {
          return yield* new PrdNotFoundError({
            message: `PRD with id ${id} not found`,
            cause: undefined,
          });
        }

        const updatedPrd: Prd = {
          ...prd,
          syncStatus: status,
          lastSyncError: error,
          updatedAt: new Date().toISOString(),
        };

        prdsStore.set(id, updatedPrd);
        return updatedPrd;
      }),
  };

  return {
    service,
    layer: Layer.succeed(PrdRepository, service),
    setPrds: (prds: Prd[]): void => {
      prdsStore.clear();
      for (const prd of prds) {
        prdsStore.set(prd.id, prd);
      }
    },
    getPrds: (): ReadonlyArray<Prd> => {
      return Array.from(prdsStore.values());
    },
    simulateSyncResult: (
      prdId: string,
      result: SyncPrdResult | GoogleDocsApiError,
    ): void => {
      syncResults.set(prdId, result);
    },
    reset: (): void => {
      prdsStore.clear();
      syncResults.clear();
    },
  };
};
