'use client';

import { useCallback, useState, type JSX } from 'react';

import classnames from 'classnames';

import type { Gate } from './types';
import { checkAllGatesPassed } from './types';
import styles from './StateTransitionButtons.module.scss';

/**
 * Represents an available state transition.
 */
type AvailableTransition = {
  readonly toState: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly disabledReason?: string;
};

/**
 * States that require all gates to pass before transition.
 */
const GATE_REQUIRED_TRANSITIONS = new Set(['CONVERGED']);

/**
 * Props for StateTransitionButtons component.
 */
type StateTransitionButtonsProps = {
  /** Current spec group state */
  readonly currentState: string;
  /** Available transitions from the current state */
  readonly availableTransitions: readonly AvailableTransition[];
  /** Current gate status */
  readonly gates: readonly Gate[];
  /** Callback when a transition is requested */
  readonly onTransition: (toState: string) => Promise<void>;
  /** Whether a transition is currently in progress */
  readonly isTransitioning?: boolean;
  /** Optional additional CSS class */
  readonly className?: string;
};

/**
 * Lock icon for disabled transitions.
 */
const LockIcon = (): JSX.Element => (
  <svg
    aria-hidden="true"
    className={styles.lockIcon}
    fill="currentColor"
    viewBox="0 0 20 20"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      clipRule="evenodd"
      d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z"
      fillRule="evenodd"
    />
  </svg>
);

/**
 * Arrow icon for enabled transitions.
 */
const ArrowIcon = (): JSX.Element => (
  <svg
    aria-hidden="true"
    className={styles.arrowIcon}
    fill="currentColor"
    viewBox="0 0 20 20"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      clipRule="evenodd"
      d="M10.293 3.293a1 1 0 011.414 0l6 6a1 1 0 010 1.414l-6 6a1 1 0 01-1.414-1.414L14.586 11H3a1 1 0 110-2h11.586l-4.293-4.293a1 1 0 010-1.414z"
      fillRule="evenodd"
    />
  </svg>
);

/**
 * Spinner icon for loading state.
 */
const SpinnerIcon = (): JSX.Element => (
  <svg
    aria-hidden="true"
    className={styles.spinnerIcon}
    fill="none"
    viewBox="0 0 24 24"
    xmlns="http://www.w3.org/2000/svg"
  >
    <circle
      className={styles.spinnerTrack}
      cx="12"
      cy="12"
      r="10"
      stroke="currentColor"
      strokeWidth="4"
    />
    <path
      className={styles.spinnerPath}
      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      fill="currentColor"
    />
  </svg>
);

/**
 * StateTransitionButtons Component (AC8.6)
 *
 * Displays state transition buttons that are:
 * - Enabled when all preconditions are met
 * - Disabled when required gates haven't passed
 * - Shows tooltip explaining why button is disabled
 */
export const StateTransitionButtons = ({
  currentState: _currentState,
  availableTransitions,
  gates,
  onTransition,
  isTransitioning = false,
  className,
}: StateTransitionButtonsProps): JSX.Element | null => {
  const [activeTransition, setActiveTransition] = useState<string | null>(null);

  const allGatesPassed = checkAllGatesPassed(gates);

  const handleTransition = useCallback(
    async (toState: string): Promise<void> => {
      setActiveTransition(toState);
      try {
        await onTransition(toState);
      } finally {
        setActiveTransition(null);
      }
    },
    [onTransition],
  );

  if (availableTransitions.length === 0) {
    return null;
  }

  return (
    <div className={classnames(styles.container, className)}>
      <h3 className={styles.heading}>Transition to</h3>
      <div className={styles.buttonGroup}>
        {availableTransitions.map((transition) => {
          // Check if this transition requires gates to pass (AC8.6)
          const requiresGates = GATE_REQUIRED_TRANSITIONS.has(transition.toState);
          const gatesBlocking = requiresGates && !allGatesPassed;

          // Determine if button is disabled
          const isDisabled =
            isTransitioning ||
            !transition.enabled ||
            gatesBlocking;

          // Determine disabled reason
          let disabledReason = transition.disabledReason;
          if (gatesBlocking) {
            disabledReason = 'All convergence gates must pass before this transition';
          }

          const isLoading = activeTransition === transition.toState;

          return (
            <div className={styles.buttonWrapper} key={transition.toState}>
              <button
                aria-describedby={
                  isDisabled && disabledReason
                    ? `tooltip-${transition.toState}`
                    : undefined
                }
                aria-disabled={isDisabled}
                className={classnames(
                  styles.transitionButton,
                  isDisabled && styles.transitionButtonDisabled,
                  gatesBlocking && styles.transitionButtonGated,
                )}
                disabled={isDisabled}
                onClick={(): void => {
                  if (!isDisabled) {
                    handleTransition(transition.toState);
                  }
                }}
                type="button"
              >
                <span className={styles.buttonContent}>
                  {isLoading ? (
                    <SpinnerIcon />
                  ) : isDisabled && gatesBlocking ? (
                    <LockIcon />
                  ) : (
                    <ArrowIcon />
                  )}
                  <span className={styles.buttonLabel}>{transition.toState}</span>
                </span>
              </button>

              {isDisabled && disabledReason && (
                <div
                  className={styles.tooltip}
                  id={`tooltip-${transition.toState}`}
                  role="tooltip"
                >
                  {disabledReason}
                </div>
              )}

              <span className={styles.transitionDescription}>
                {transition.description}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export type { AvailableTransition, StateTransitionButtonsProps };
