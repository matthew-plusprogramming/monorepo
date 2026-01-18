'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ConvergenceGateState, Gate } from './types';
import { createDefaultGates } from './types';

/**
 * Configuration for the convergence gates hook.
 */
type UseConvergenceGatesConfig = {
  /** Spec group ID to fetch gates for */
  readonly specGroupId: string;
  /** API URL (defaults to NEXT_PUBLIC_API_URL or localhost:3000) */
  readonly apiUrl?: string;
  /** Polling interval in ms for automatic updates (AC8.4) */
  readonly pollingInterval?: number;
  /** Enable/disable the hook */
  readonly enabled?: boolean;
};

/**
 * Return type for the convergence gates hook.
 */
type UseConvergenceGatesResult = {
  /** Current gate state */
  readonly gates: readonly Gate[];
  /** Whether all gates have passed */
  readonly allGatesPassed: boolean;
  /** Loading state */
  readonly isLoading: boolean;
  /** Error message if any */
  readonly error: string | null;
  /** Last successful update timestamp */
  readonly updatedAt: string | null;
  /** Manually refresh gate status */
  readonly refresh: () => Promise<void>;
  /** Toggle gate expansion */
  readonly toggleGateExpansion: (gateId: string) => void;
  /** Currently expanded gate IDs */
  readonly expandedGates: ReadonlySet<string>;
};

const DEFAULT_API_URL = 'http://localhost:3000';

const getApiUrl = (baseUrl?: string): string =>
  baseUrl ?? process.env.NEXT_PUBLIC_API_URL ?? DEFAULT_API_URL;

/**
 * Hook for fetching and managing convergence gate status (AS-008).
 *
 * Features:
 * - AC8.1: Fetches all gates as checklist data
 * - AC8.4: Gate status updates automatically via polling
 * - AC8.5: Manages gate expansion state for details
 */
export const useConvergenceGates = (
  config: UseConvergenceGatesConfig,
): UseConvergenceGatesResult => {
  const {
    specGroupId,
    apiUrl,
    pollingInterval = 10000,
    enabled = true,
  } = config;

  const [gateState, setGateState] = useState<ConvergenceGateState | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedGates, setExpandedGates] = useState<Set<string>>(new Set());

  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const isMountedRef = useRef(true);

  /**
   * Fetch gate status from API.
   */
  const fetchGates = useCallback(async (): Promise<void> => {
    if (!isMountedRef.current || !specGroupId) {
      return;
    }

    try {
      const response = await fetch(
        `${getApiUrl(apiUrl)}/api/spec-groups/${specGroupId}/gates`,
        {
          method: 'GET',
          headers: { Accept: 'application/json' },
          credentials: 'include',
        },
      );

      if (response.ok) {
        const data = (await response.json()) as ConvergenceGateState;
        if (isMountedRef.current) {
          setGateState(data);
          setError(null);
        }
      } else if (response.status === 404) {
        // Spec group not found, use default gates
        if (isMountedRef.current) {
          setGateState({
            specGroupId,
            gates: createDefaultGates(),
            allGatesPassed: false,
            updatedAt: new Date().toISOString(),
          });
          setError(null);
        }
      } else {
        throw new Error(`Failed to fetch gates: ${response.status}`);
      }
    } catch (err) {
      if (isMountedRef.current) {
        setError(err instanceof Error ? err.message : 'Failed to fetch gates');
      }
    } finally {
      if (isMountedRef.current) {
        setIsLoading(false);
      }
    }
  }, [specGroupId, apiUrl]);

  /**
   * Manually refresh gate status.
   */
  const refresh = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    await fetchGates();
  }, [fetchGates]);

  /**
   * Toggle gate expansion for showing details (AC8.5).
   */
  const toggleGateExpansion = useCallback((gateId: string): void => {
    setExpandedGates((prev) => {
      const next = new Set(prev);
      if (next.has(gateId)) {
        next.delete(gateId);
      } else {
        next.add(gateId);
      }
      return next;
    });
  }, []);

  /**
   * Start polling for updates (AC8.4).
   */
  const startPolling = useCallback((): void => {
    if (pollingIntervalRef.current) {
      return;
    }

    pollingIntervalRef.current = setInterval(() => {
      fetchGates();
    }, pollingInterval);
  }, [fetchGates, pollingInterval]);

  /**
   * Stop polling.
   */
  const stopPolling = useCallback((): void => {
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }
  }, []);

  // Initial fetch and polling setup
  useEffect(() => {
    isMountedRef.current = true;

    if (enabled && specGroupId) {
      fetchGates();
      startPolling();
    }

    return () => {
      isMountedRef.current = false;
      stopPolling();
    };
  }, [enabled, specGroupId, fetchGates, startPolling, stopPolling]);

  // Memoized gates with defaults
  const gates = useMemo(
    () => gateState?.gates ?? createDefaultGates(),
    [gateState],
  );

  const allGatesPassed = useMemo(
    () => gateState?.allGatesPassed ?? false,
    [gateState],
  );

  const updatedAt = useMemo(
    () => gateState?.updatedAt ?? null,
    [gateState],
  );

  return useMemo(
    () => ({
      gates,
      allGatesPassed,
      isLoading,
      error,
      updatedAt,
      refresh,
      toggleGateExpansion,
      expandedGates: expandedGates as ReadonlySet<string>,
    }),
    [gates, allGatesPassed, isLoading, error, updatedAt, refresh, toggleGateExpansion, expandedGates],
  );
};

export type { UseConvergenceGatesConfig, UseConvergenceGatesResult };
