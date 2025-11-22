'use client';

import { useEffect } from 'react';

import { useRouter } from 'next/navigation';
import type { JSX } from 'react';

import { Navbar } from '@/components/Navbar';
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
    <div className={styles.page}>
      <Navbar />

      <main className={styles.main}>
        <section className={styles.card}>
          <p className={styles.eyebrow}>Home</p>
          <h1 className={styles.title}>Welcome home</h1>
          <p className={styles.lead}>
            You are signed in. This private space will soon grow into your
            project control room, keeping auth state intact between refreshes.
          </p>
          <div className={styles.meta}>
            <span>Token stored securely in your session.</span>
            <span>
              Refreshing will keep you here while you remain signed in.
            </span>
          </div>
        </section>
      </main>
    </div>
  );
};

export default HomePage;
