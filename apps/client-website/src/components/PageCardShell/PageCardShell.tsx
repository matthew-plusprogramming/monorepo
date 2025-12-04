'use client';

import classNames from 'classnames';
import type { JSX, ReactNode } from 'react';

import styles from './PageCardShell.module.scss';

type PageCardShellProps = {
  children: ReactNode;
  eyebrow?: ReactNode;
  eyebrowClassName?: string;
  header?: ReactNode;
  mainAriaLabel: string;
  cardAriaLabel?: string;
  cardAriaLabelledBy?: string;
  cardClassName?: string;
};

const PageCardShell = ({
  children,
  eyebrow,
  eyebrowClassName,
  header,
  mainAriaLabel,
  cardAriaLabel,
  cardAriaLabelledBy,
  cardClassName,
}: PageCardShellProps): JSX.Element => {
  const cardClass = classNames(styles.card, cardClassName);
  const eyebrowClass = classNames(styles.eyebrow, eyebrowClassName);

  return (
    <div className={styles.page}>
      {header}
      <main aria-label={mainAriaLabel} className={styles.main}>
        <section
          aria-label={cardAriaLabel}
          aria-labelledby={cardAriaLabelledBy}
          className={cardClass}
        >
          {eyebrow ? <p className={eyebrowClass}>{eyebrow}</p> : null}
          {children}
        </section>
      </main>
    </div>
  );
};

export { PageCardShell };
export type { PageCardShellProps };
