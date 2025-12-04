'use client';

import { useEffect } from 'react';

import { useRouter } from 'next/navigation';
import type { JSX } from 'react';

import { Navbar } from '@/components/Navbar';
import { PageCardShell } from '@/components/PageCardShell';
import { useUserStore } from '@/stores/userStore';

import styles from './page.module.scss';

const HomePage = (): JSX.Element | null => {
  const router = useRouter();
  const token = useUserStore((state) => state.token);
  const hasHydrated = useUserStore((state) => state.hasHydrated);

  useEffect(() => {
    if (!hasHydrated) {
      return;
    }

    if (!token) {
      router.replace('/login');
    }
  }, [hasHydrated, token, router]);

  if (!hasHydrated) {
    return null;
  }

  if (!token) {
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
