'use client';

import type { JSX } from 'react';

import { Navbar } from '@/components/Navbar';
import { PageCardShell } from '@/components/PageCardShell';
import { useProtectedPage } from '@/hooks/useProtectedPage';

import styles from './page.module.scss';

const HomePage = (): JSX.Element | null => {
  const { canRender } = useProtectedPage();

  if (!canRender) {
    return null;
  }

  return (
    <PageCardShell
      cardAriaLabel="Authenticated home"
      cardAriaLabelledBy="home-title"
      eyebrow="Home"
      headingId="home-title"
      header={<Navbar />}
      mainAriaLabel="Home page"
      subtitle="You are signed in. This private space will soon grow into your project control room, keeping auth state intact between refreshes."
      title="Welcome home"
    >
      <div aria-label="Session details" className={styles.meta}>
        <span>Token stored securely in your session.</span>
        <span>Refreshing will keep you here while you remain signed in.</span>
      </div>
    </PageCardShell>
  );
};

export default HomePage;
