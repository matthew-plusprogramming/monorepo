'use client';

import classNames from 'classnames';
import type { JSX, KeyboardEvent } from 'react';

import type { Project, ProjectHealth } from '@/lib/api/projects';

import styles from './ProjectCard.module.scss';

/**
 * Props for the ProjectCard component.
 */
type ProjectCardProps = {
  /** Project data to display */
  readonly project: Project;
  /** Click handler for card navigation */
  readonly onClick?: (project: Project) => void;
};

/**
 * Props for the ProjectCard skeleton loader.
 */
type ProjectCardSkeletonProps = {
  /** Unique key for the skeleton */
  readonly id?: string;
};

/**
 * Health indicator labels for accessibility (AC1.3).
 */
const HEALTH_LABELS: Record<ProjectHealth, string> = {
  green: 'All gates pass',
  yellow: 'Some gates pass',
  red: 'Critical gates fail',
};

/**
 * Format relative time for display.
 */
const formatRelativeTime = (dateString: string): string => {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSeconds < 60) {
    return 'just now';
  }
  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }
  if (diffDays < 7) {
    return `${diffDays}d ago`;
  }

  return date.toLocaleDateString();
};

/**
 * Format spec group count for display (AC1.2).
 */
const formatSpecGroupCount = (count: number): string => {
  if (count === 0) {
    return 'No spec groups';
  }
  if (count === 1) {
    return '1 spec group';
  }
  return `${count} spec groups`;
};

/**
 * Spec group icon SVG.
 */
const SpecGroupIcon = (): JSX.Element => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="16" y1="13" x2="8" y2="13" />
    <line x1="16" y1="17" x2="8" y2="17" />
    <polyline points="10 9 9 9 8 9" />
  </svg>
);

/**
 * ProjectCard component (AS-001, AC1.1, AC1.2, AC1.3).
 *
 * Displays a project as a card with:
 * - Name and status (AC1.1)
 * - Spec group count (AC1.2)
 * - Health indicator (AC1.3)
 */
export const ProjectCard = ({
  project,
  onClick,
}: ProjectCardProps): JSX.Element => {
  const handleClick = (): void => {
    onClick?.(project);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onClick?.(project);
    }
  };

  const healthClass = classNames(styles.healthIndicator, styles[project.health]);

  return (
    <article
      className={styles.card}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      tabIndex={0}
      role="button"
      aria-label={`Project: ${project.name}`}
    >
      <header className={styles.header}>
        <div className={styles.titleWrapper}>
          <h3 className={styles.name}>{project.name}</h3>
          <span className={styles.status}>{project.status}</span>
        </div>
        <div
          className={healthClass}
          role="status"
          aria-label={`Health: ${HEALTH_LABELS[project.health]}`}
          title={HEALTH_LABELS[project.health]}
        />
      </header>

      {project.description ? (
        <p className={styles.description}>{project.description}</p>
      ) : null}

      <footer className={styles.footer}>
        <div className={styles.specGroupCount}>
          <span className={styles.specGroupIcon}>
            <SpecGroupIcon />
          </span>
          <span>{formatSpecGroupCount(project.specGroupCount)}</span>
        </div>
        <time className={styles.updatedAt} dateTime={project.updatedAt}>
          {formatRelativeTime(project.updatedAt)}
        </time>
      </footer>
    </article>
  );
};

/**
 * ProjectCard skeleton for loading state.
 */
export const ProjectCardSkeleton = ({
  id: _id,
}: ProjectCardSkeletonProps): JSX.Element => (
  <div className={styles.card} aria-busy="true" aria-label="Loading project">
    <header className={styles.header}>
      <div className={styles.titleWrapper}>
        <div className={styles.skeletonName} />
      </div>
    </header>
    <div className={styles.skeletonDescription} />
    <footer className={styles.footer}>
      <div className={styles.skeletonFooter} />
    </footer>
  </div>
);

export type { ProjectCardProps, ProjectCardSkeletonProps };
