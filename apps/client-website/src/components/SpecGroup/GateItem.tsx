'use client';

import type { JSX } from 'react';

import classnames from 'classnames';

import type { Gate, GateDetail, GateStatus } from './types';
import { GATE_DISPLAY_CONFIG } from './types';
import styles from './GateItem.module.scss';

/**
 * Status icon components (AC8.2).
 * - Passed: Green check
 * - Failed: Red X
 * - Pending: Gray circle
 * - N/A: Dash
 */
const CheckIcon = (): JSX.Element => (
  <svg
    aria-hidden="true"
    className={classnames(styles.statusIcon, styles.statusIconPassed)}
    fill="currentColor"
    viewBox="0 0 20 20"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      clipRule="evenodd"
      d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
      fillRule="evenodd"
    />
  </svg>
);

const XIcon = (): JSX.Element => (
  <svg
    aria-hidden="true"
    className={classnames(styles.statusIcon, styles.statusIconFailed)}
    fill="currentColor"
    viewBox="0 0 20 20"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      clipRule="evenodd"
      d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
      fillRule="evenodd"
    />
  </svg>
);

const PendingIcon = (): JSX.Element => (
  <svg
    aria-hidden="true"
    className={classnames(styles.statusIcon, styles.statusIconPending)}
    fill="currentColor"
    viewBox="0 0 20 20"
    xmlns="http://www.w3.org/2000/svg"
  >
    <circle cx="10" cy="10" r="6" />
  </svg>
);

const NAIcon = (): JSX.Element => (
  <svg
    aria-hidden="true"
    className={classnames(styles.statusIcon, styles.statusIconNA)}
    fill="currentColor"
    viewBox="0 0 20 20"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      clipRule="evenodd"
      d="M3 10a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z"
      fillRule="evenodd"
    />
  </svg>
);

const ChevronIcon = ({ isExpanded }: { isExpanded: boolean }): JSX.Element => (
  <svg
    aria-hidden="true"
    className={classnames(
      styles.chevronIcon,
      isExpanded && styles.chevronIconExpanded,
    )}
    fill="currentColor"
    viewBox="0 0 20 20"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      clipRule="evenodd"
      d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
      fillRule="evenodd"
    />
  </svg>
);

/**
 * Get the appropriate status icon for a gate status.
 */
const getStatusIcon = (status: GateStatus): JSX.Element => {
  switch (status) {
    case 'passed':
      return <CheckIcon />;
    case 'failed':
      return <XIcon />;
    case 'pending':
      return <PendingIcon />;
    case 'na':
      return <NAIcon />;
  }
};

/**
 * Get aria label for status.
 */
const getStatusAriaLabel = (status: GateStatus): string => {
  switch (status) {
    case 'passed':
      return 'Passed';
    case 'failed':
      return 'Failed';
    case 'pending':
      return 'Pending';
    case 'na':
      return 'Not applicable';
  }
};

/**
 * Gate detail item component (AC8.5).
 */
const GateDetailItem = ({ detail }: { detail: GateDetail }): JSX.Element => {
  const severityClass = detail.severity
    ? styles[`detailSeverity${detail.severity.charAt(0).toUpperCase()}${detail.severity.slice(1)}`]
    : undefined;

  return (
    <li className={classnames(styles.detailItem, severityClass)}>
      <span className={styles.detailMessage}>{detail.message}</span>
      {detail.location && (
        <span className={styles.detailLocation}>{detail.location}</span>
      )}
      {detail.timestamp && (
        <time className={styles.detailTimestamp} dateTime={detail.timestamp}>
          {new Date(detail.timestamp).toLocaleString()}
        </time>
      )}
    </li>
  );
};

/**
 * Props for GateItem component.
 */
type GateItemProps = {
  /** Gate data */
  readonly gate: Gate;
  /** Whether the gate details are expanded */
  readonly isExpanded: boolean;
  /** Callback when gate is clicked to expand/collapse */
  readonly onToggle: () => void;
};

/**
 * GateItem Component (AC8.1, AC8.2, AC8.5)
 *
 * Displays a single convergence gate with:
 * - Status icon (passed/failed/pending/na)
 * - Gate label and description
 * - Expandable details section
 */
export const GateItem = ({
  gate,
  isExpanded,
  onToggle,
}: GateItemProps): JSX.Element => {
  const config = GATE_DISPLAY_CONFIG[gate.id];
  const hasDetails = gate.details && gate.details.length > 0;
  const isClickable = hasDetails || gate.status === 'failed';

  const statusClass = styles[`gateStatus${gate.status.charAt(0).toUpperCase()}${gate.status.slice(1)}`];

  const handleKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onToggle();
    }
  };

  return (
    <div
      aria-expanded={isClickable ? isExpanded : undefined}
      className={classnames(
        styles.gateItem,
        statusClass,
        isClickable && styles.gateItemClickable,
        isExpanded && styles.gateItemExpanded,
      )}
      onClick={isClickable ? onToggle : undefined}
      onKeyDown={isClickable ? handleKeyDown : undefined}
      role={isClickable ? 'button' : undefined}
      tabIndex={isClickable ? 0 : undefined}
    >
      <div className={styles.gateHeader}>
        <span
          aria-label={getStatusAriaLabel(gate.status)}
          className={styles.statusIconWrapper}
          role="img"
        >
          {getStatusIcon(gate.status)}
        </span>
        <div className={styles.gateInfo}>
          <span className={styles.gateLabel}>{config.label}</span>
          <span className={styles.gateDescription}>{config.description}</span>
        </div>
        {isClickable && (
          <span className={styles.expandIndicator}>
            <ChevronIcon isExpanded={isExpanded} />
          </span>
        )}
      </div>

      {isExpanded && hasDetails && (
        <div className={styles.gateDetails}>
          <ul className={styles.detailsList} role="list">
            {gate.details?.map((detail, index) => (
              <GateDetailItem
                detail={detail}
                key={`${detail.type}-${detail.message}-${index}`}
              />
            ))}
          </ul>
        </div>
      )}

      {isExpanded && !hasDetails && gate.status === 'failed' && (
        <div className={styles.gateDetails}>
          <p className={styles.noDetailsMessage}>
            No additional details available. Check the logs for more information.
          </p>
        </div>
      )}
    </div>
  );
};

export type { GateItemProps };
