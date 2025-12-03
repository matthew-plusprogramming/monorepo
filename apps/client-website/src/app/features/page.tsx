import type { JSX } from 'react';

import { PublicNavbar } from '@/components/Navbar';
import { PageCardShell } from '@/components/PageCardShell';

import styles from './page.module.scss';

type Feature = {
  title: string;
  description: string;
};

const features: Feature[] = [
  {
    title: 'Typed monorepo foundation',
    description:
      'Opinionated packages, shared types, and a single toolchain keep backend, frontend, and infra aligned.',
  },
  {
    title: 'Auth-ready flows',
    description:
      'Built-in login and signup experiences keep users on the happy path while preserving accessibility and state.',
  },
  {
    title: 'Reusable UI building blocks',
    description:
      'Buttons, toasts, navigation, and page shells help teams ship consistent surfaces without reinventing patterns.',
  },
  {
    title: 'Cloud-first operations',
    description:
      'Infrastructure is defined in code so environments stay predictable as projects grow from prototype to launch.',
  },
  {
    title: 'Analytics backbone',
    description:
      'Event streams and observability hooks are ready to capture product signals so you can measure impact from day one.',
  },
  {
    title: 'Helper scripts',
    description:
      'Repository scripts and utilities live alongside the codebase to automate chores like setup, linting, and releases.',
  },
];

const FeaturesPage = (): JSX.Element => {
  return (
    <PageCardShell
      cardAriaLabel="Feature highlights"
      cardAriaLabelledBy="features-title"
      cardClassName={styles.card}
      header={<PublicNavbar />}
      mainAriaLabel="Features page"
    >
      <header className={styles.header}>
        <p className={styles.eyebrow}>Features</p>
        <h1 className={styles.title} id="features-title">
          Ship faster with a collaborative monorepo
        </h1>
        <p className={styles.lead}>
          Explore the guardrails and components that keep this stack cohesive.
          Everything is set up to help you move quickly without sacrificing
          clarity.
        </p>
      </header>

      <ul aria-label="Key features" className={styles.featureList}>
        {features.map((feature) => (
          <li className={styles.featureItem} key={feature.title}>
            <h2 className={styles.featureTitle}>{feature.title}</h2>
            <p className={styles.featureDescription}>{feature.description}</p>
          </li>
        ))}
      </ul>
    </PageCardShell>
  );
};

export default FeaturesPage;
