'use client';

import classNames from 'classnames';
import type { JSX, ReactNode } from 'react';

import styles from './PageCardShell.module.scss';

type PageCardShellProps = {
  children: ReactNode;
  header?: ReactNode;
  mainAriaLabel: string;
  cardAriaLabel?: string;
  cardAriaLabelledBy?: string;
  cardClassName?: string;
};

const PageCardShell = ({
  children,
  header,
  mainAriaLabel,
  cardAriaLabel,
  cardAriaLabelledBy,
  cardClassName,
}: PageCardShellProps): JSX.Element => {
  const cardClass = classNames(styles.card, cardClassName);

  return (
    <div className={styles.page}>
      {header}
      <main aria-label={mainAriaLabel} className={styles.main}>
        <section
          aria-label={cardAriaLabel}
          aria-labelledby={cardAriaLabelledBy}
          className={cardClass}
        >
          {children}
        </section>
      </main>
    </div>
  );
};

export { PageCardShell };
export type { PageCardShellProps };
