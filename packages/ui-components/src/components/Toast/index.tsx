import classnames from 'classnames';
import type { JSX } from 'react';

import styles from './Toast.module.scss';

type ToastVariant = 'success' | 'error';

type ToastProps = {
  message: string;
  onDismiss?: () => void;
  variant?: ToastVariant;
};

const variantTitle: Record<ToastVariant, string> = {
  success: 'Success',
  error: 'Error',
};

const Toast = ({
  message,
  onDismiss,
  variant = 'success',
}: ToastProps): JSX.Element => {
  const ariaRole = variant === 'error' ? 'alert' : 'status';
  const ariaLive = variant === 'error' ? 'assertive' : 'polite';

  return (
    <div
      aria-live={ariaLive}
      className={classnames(styles.toast, styles[variant])}
      role={ariaRole}
    >
      <span aria-hidden="true" className={styles.badge}>
        <svg
          className={styles.icon}
          fill="none"
          height="18"
          viewBox="0 0 18 18"
          width="18"
        >
          <circle cx="9" cy="9" r="8" stroke="currentColor" />
          <path
            d="M5.5 9.3 7.7 11.5 12.5 6.5"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>

      <div className={styles.copy}>
        <p className={styles.title}>{variantTitle[variant]}</p>
        <p className={styles.message}>{message}</p>
      </div>

      {onDismiss ? (
        <button
          aria-label="Dismiss notification"
          className={styles.dismissButton}
          onClick={onDismiss}
          type="button"
        >
          Close
        </button>
      ) : null}
    </div>
  );
};

export { Toast };
export type { ToastProps };
