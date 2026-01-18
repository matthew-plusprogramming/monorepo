'use client';

import { useQuery } from '@tanstack/react-query';
import { useCallback } from 'react';

import { fetchProjects, type ListProjectsResponse } from '@/lib/api/projects';

/**
 * Configuration for the useProjects hook.
 */
type UseProjectsConfig = {
  /** Enable/disable the hook */
  readonly enabled?: boolean;
  /** Polling interval in ms for real-time updates (AC1.5). Default: 5000 */
  readonly pollingInterval?: number;
  /** Enable polling for real-time updates (AC1.5). Default: true */
  readonly enablePolling?: boolean;
};

/**
 * Return type for the useProjects hook.
 */
type UseProjectsResult = {
  /** List of projects */
  readonly projects: ListProjectsResponse['projects'];
  /** Total count of projects */
  readonly total: number;
  /** Whether the initial load is in progress */
  readonly isLoading: boolean;
  /** Whether a refetch is in progress */
  readonly isFetching: boolean;
  /** Error message if any */
  readonly error: string | null;
  /** Manually refresh projects */
  readonly refresh: () => Promise<void>;
};

/**
 * Query key for projects.
 */
const PROJECTS_QUERY_KEY = ['projects'] as const;

/**
 * Default polling interval (5 seconds) for real-time updates (AC1.5).
 */
const DEFAULT_POLLING_INTERVAL = 5000;

/**
 * Hook for fetching projects with real-time updates (AS-001).
 *
 * Features:
 * - AC1.4: Projects load within 3 seconds on initial page load
 * - AC1.5: Status indicators update in real-time without page refresh
 */
export const useProjects = (
  config: UseProjectsConfig = {},
): UseProjectsResult => {
  const {
    enabled = true,
    pollingInterval = DEFAULT_POLLING_INTERVAL,
    enablePolling = true,
  } = config;

  const {
    data,
    isLoading,
    isFetching,
    error,
    refetch,
  } = useQuery({
    queryKey: PROJECTS_QUERY_KEY,
    queryFn: fetchProjects,
    enabled,
    // AC1.5: Enable polling for real-time updates
    refetchInterval: enablePolling ? pollingInterval : false,
    // Keep previous data while fetching for smooth UX
    placeholderData: (previousData) => previousData,
    // AC1.4: Stale time to minimize initial load delay
    staleTime: pollingInterval,
  });

  const refresh = useCallback(async (): Promise<void> => {
    await refetch();
  }, [refetch]);

  return {
    projects: data?.projects ?? [],
    total: data?.total ?? 0,
    isLoading,
    isFetching,
    error: error instanceof Error ? error.message : null,
    refresh,
  };
};

export { PROJECTS_QUERY_KEY };
export type { UseProjectsConfig, UseProjectsResult };
