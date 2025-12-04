import type { JSX } from 'react';

import { PublicNavbar } from '@/components/Navbar';
import { PageCardShell } from '@/components/PageCardShell';

import styles from './page.module.scss';

type ComponentCallout = {
  title: string;
  description: string;
};

const componentCallouts: ComponentCallout[] = [
  {
    title: 'Buttons and links',
    description:
      'CTA and secondary variants with flat or 3D interactions work as native buttons or Next.js links.',
  },
  {
    title: 'Public navigation',
    description:
      'Responsive navbar with brand lockup, feature and auth links, and focus-visible states baked in.',
  },
  {
    title: 'Page card shells',
    description:
      'Gradient-backed page wrapper that centers marketing and auth content inside an accessible card.',
  },
  {
    title: 'Dropdown menus',
    description:
      'Keyboard-friendly menu component ready for account pickers and overflow actions.',
  },
  {
    title: 'Toast notifications',
    description:
      'Non-blocking feedback surface that respects reduced motion and keeps messages legible.',
  },
];

const ComponentsPage = (): JSX.Element => {
  return (
    <PageCardShell
      cardAriaLabel="Component highlights"
      cardAriaLabelledBy="components-title"
      cardClassName={styles.card}
      eyebrow="Components"
      header={<PublicNavbar />}
      mainAriaLabel="Components page"
    >
      <header className={styles.header}>
        <h1 className={styles.title} id="components-title">
          Build pages with reusable UI primitives
        </h1>
        <p className={styles.lead}>
          Browse the components that ship with this monorepo. Each piece is
          typed, styled, and ready to drop into both marketing and product
          flows.
        </p>
      </header>

      <ul aria-label="UI components" className={styles.componentList}>
        {componentCallouts.map((component) => (
          <li className={styles.componentItem} key={component.title}>
            <h2 className={styles.componentTitle}>{component.title}</h2>
            <p className={styles.componentDescription}>
              {component.description}
            </p>
          </li>
        ))}
      </ul>
    </PageCardShell>
  );
};

export default ComponentsPage;
