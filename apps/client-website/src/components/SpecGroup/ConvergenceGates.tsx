'use client';

import type { JSX } from 'react';
import { useEffect, useRef } from 'react';

import classnames from 'classnames';

import { GateItem } from './GateItem';
import type { Gate } from './types';
import { GATE_ORDER } from './types';
import { useConvergenceGates } from './useConvergenceGates';
import styles from './ConvergenceGates.module.scss';

/**
 * Loading skeleton for gate items.
 */
const GateItemSkeleton = (): JSX.Element => (
  <div className={styles.gateItemSkeleton}>
    <div className={styles.skeletonIcon} />
    <div className={styles.skeletonContent}>
      <div className={styles.skeletonLabel} />
      <div className={styles.skeletonDescription} />
    </div>
  </div>
);

/**
 * Error display component.
 */
const ErrorDisplay = ({
  error,
  onRetry,
}: {
  error: string;
  onRetry: () => void;
}): JSX.Element => (
  <div className={styles.errorContainer} role="alert">
    <p className={styles.errorMessage}>Failed to load gates: {error}</p>
    <button className={styles.retryButton} onClick={onRetry} type="button">
      Retry
    </button>
  </div>
);

/**
 * Summary badge showing passed/total gates.
 */
const GateSummary = ({
  gates,
  allGatesPassed,
}: {
  gates: readonly Gate[];
  allGatesPassed: boolean;
}): JSX.Element => {
  const passedCount = gates.filter((g) => g.status === 'passed').length;
  const totalCount = gates.filter((g) => g.status !== 'na').length;

  return (
    <div
      className={classnames(
        styles.summary,
        allGatesPassed ? styles.summaryPassed : styles.summaryPending,
      )}
    >
      <span className={styles.summaryLabel}>
        {allGatesPassed ? 'All gates passed' : `${passedCount}/${totalCount} gates passed`}
      </span>
    </div>
  );
};

/**
 * Props for ConvergenceGates component.
 */
type ConvergenceGatesProps = {
  /** Spec group ID to display gates for */
  readonly specGroupId: string;
  /** Optional API URL override */
  readonly apiUrl?: string;
  /** Optional polling interval in ms */
  readonly pollingInterval?: number;
  /** Optional callback when all gates pass */
  readonly onAllGatesPassed?: () => void;
  /** Optional additional CSS class */
  readonly className?: string;
};

/**
 * ConvergenceGates Component (AC8.1, AC8.3, AC8.4)
 *
 * Displays the convergence gate checklist for a spec group showing:
 * - All quality gates with their status (AC8.3)
 * - Summary of passed/total gates
 * - Auto-updating gate status (AC8.4)
 * - Expandable details for failed gates (AC8.5)
 */
export const ConvergenceGates = ({
  specGroupId,
  apiUrl,
  pollingInterval,
  onAllGatesPassed,
  className,
}: ConvergenceGatesProps): JSX.Element => {
  const {
    gates,
    allGatesPassed,
    isLoading,
    error,
    refresh,
    toggleGateExpansion,
    expandedGates,
  } = useConvergenceGates({
    specGroupId,
    apiUrl,
    pollingInterval,
    enabled: true,
  });

  // Track previous allGatesPassed state to only notify on change
  const prevAllGatesPassedRef = useRef<boolean>(false);

  // Notify when all gates pass (moved to useEffect to avoid side-effects in render)
  useEffect(() => {
    if (allGatesPassed && !prevAllGatesPassedRef.current && onAllGatesPassed) {
      onAllGatesPassed();
    }
    prevAllGatesPassedRef.current = allGatesPassed;
  }, [allGatesPassed, onAllGatesPassed]);

  // Sort gates according to defined order
  const sortedGates = [...gates].sort((a, b) => {
    const aIndex = GATE_ORDER.indexOf(a.id);
    const bIndex = GATE_ORDER.indexOf(b.id);
    return aIndex - bIndex;
  });

  return (
    <section
      aria-labelledby="convergence-gates-heading"
      className={classnames(styles.container, className)}
    >
      <header className={styles.header}>
        <h2 className={styles.heading} id="convergence-gates-heading">
          Convergence Gates
        </h2>
        {!isLoading && !error && (
          <GateSummary allGatesPassed={allGatesPassed} gates={gates} />
        )}
      </header>

      {isLoading && (
        <div className={styles.gateList} role="list">
          {GATE_ORDER.map((id) => (
            <GateItemSkeleton key={id} />
          ))}
        </div>
      )}

      {error && <ErrorDisplay error={error} onRetry={refresh} />}

      {!isLoading && !error && (
        <div className={styles.gateList} role="list">
          {sortedGates.map((gate) => (
            <GateItem
              gate={gate}
              isExpanded={expandedGates.has(gate.id)}
              key={gate.id}
              onToggle={(): void => toggleGateExpansion(gate.id)}
            />
          ))}
        </div>
      )}
    </section>
  );
};

export type { ConvergenceGatesProps };
