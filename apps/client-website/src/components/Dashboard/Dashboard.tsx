'use client';

import classNames from 'classnames';
import { useRouter } from 'next/navigation';
import type { JSX } from 'react';

import { useProjects } from '@/hooks/useProjects';
import type { Project } from '@/lib/api/projects';

import styles from './Dashboard.module.scss';
import { ProjectCard, ProjectCardSkeleton } from './ProjectCard';

/**
 * Props for the Dashboard component.
 */
type DashboardProps = {
  /** Enable polling for real-time updates (AC1.5). Default: true */
  readonly enablePolling?: boolean;
  /** Polling interval in ms (AC1.5). Default: 5000 */
  readonly pollingInterval?: number;
};

/**
 * Number of skeleton cards to show during loading.
 */
const SKELETON_COUNT = 6;

/**
 * Refresh icon SVG.
 */
const RefreshIcon = ({ spinning = false }: { spinning?: boolean }): JSX.Element => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={classNames(styles.refreshIcon, { [styles.spinning]: spinning })}
    aria-hidden="true"
  >
    <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" />
  </svg>
);

/**
 * Empty state icon SVG.
 */
const EmptyIcon = (): JSX.Element => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={styles.emptyIcon}
    aria-hidden="true"
  >
    <path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-6l-2-2H5a2 2 0 0 0-2 2z" />
    <line x1="12" y1="11" x2="12" y2="15" />
    <line x1="10" y1="13" x2="14" y2="13" />
  </svg>
);

/**
 * Dashboard component (AS-001).
 *
 * Main dashboard view that displays all projects as cards with:
 * - AC1.1: Project name and status
 * - AC1.2: Spec group count
 * - AC1.3: Health indicator
 * - AC1.4: Projects load within 3 seconds
 * - AC1.5: Real-time updates via polling
 */
export const Dashboard = ({
  enablePolling = true,
  pollingInterval = 5000,
}: DashboardProps): JSX.Element => {
  const router = useRouter();
  const { projects, total, isLoading, isFetching, error, refresh } = useProjects({
    enablePolling,
    pollingInterval,
  });

  const handleProjectClick = (project: Project): void => {
    router.push(`/projects/${project.id}`);
  };

  const handleRefresh = async (): Promise<void> => {
    await refresh();
  };

  // Count health statuses
  const healthCounts = projects.reduce(
    (acc, project) => {
      acc[project.health]++;
      return acc;
    },
    { green: 0, yellow: 0, red: 0 },
  );

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <div className={styles.titleWrapper}>
          <h1 className={styles.title}>Projects</h1>
          <p className={styles.subtitle}>
            {isLoading
              ? 'Loading projects...'
              : `${total} project${total !== 1 ? 's' : ''}`}
          </p>
        </div>

        <div className={styles.stats}>
          {!isLoading && total > 0 ? (
            <>
              <div className={styles.stat}>
                <span className={styles.statValue}>{healthCounts.green}</span>
                <span className={styles.statLabel}>Healthy</span>
              </div>
              <div className={styles.stat}>
                <span className={styles.statValue}>{healthCounts.yellow}</span>
                <span className={styles.statLabel}>In Progress</span>
              </div>
              <div className={styles.stat}>
                <span className={styles.statValue}>{healthCounts.red}</span>
                <span className={styles.statLabel}>Blocked</span>
              </div>
            </>
          ) : null}
        </div>

        <button
          type="button"
          className={styles.refreshButton}
          onClick={handleRefresh}
          disabled={isFetching}
          aria-label={isFetching ? 'Refreshing projects' : 'Refresh projects'}
        >
          <RefreshIcon spinning={isFetching && !isLoading} />
          <span>{isFetching && !isLoading ? 'Refreshing...' : 'Refresh'}</span>
        </button>
      </header>

      {enablePolling && !isLoading ? (
        <div className={styles.connectionStatus} role="status">
          <span className={classNames(styles.connectionDot, styles.polling)} />
          <span>Auto-updating every {pollingInterval / 1000}s</span>
        </div>
      ) : null}

      <div className={styles.grid} role="list" aria-label="Projects list">
        {/* Loading state */}
        {isLoading
          ? Array.from({ length: SKELETON_COUNT }).map((_, index) => (
              <ProjectCardSkeleton key={`skeleton-${index}`} id={`skeleton-${index}`} />
            ))
          : null}

        {/* Error state */}
        {error && !isLoading ? (
          <div className={styles.errorState} role="alert">
            <h2 className={styles.errorTitle}>Failed to load projects</h2>
            <p className={styles.errorDescription}>{error}</p>
            <button
              type="button"
              className={styles.retryButton}
              onClick={handleRefresh}
              disabled={isFetching}
            >
              Try Again
            </button>
          </div>
        ) : null}

        {/* Empty state */}
        {!isLoading && !error && projects.length === 0 ? (
          <div className={styles.emptyState}>
            <EmptyIcon />
            <h2 className={styles.emptyTitle}>No projects yet</h2>
            <p className={styles.emptyDescription}>
              Projects will appear here once spec groups are created.
            </p>
          </div>
        ) : null}

        {/* Project cards */}
        {!isLoading && !error
          ? projects.map((project) => (
              <ProjectCard
                key={project.id}
                project={project}
                onClick={handleProjectClick}
              />
            ))
          : null}
      </div>
    </div>
  );
};

export type { DashboardProps };
