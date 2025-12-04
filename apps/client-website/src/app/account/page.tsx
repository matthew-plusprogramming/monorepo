'use client';

import { useEffect, useState } from 'react';

import { useRouter } from 'next/navigation';
import type { JSX } from 'react';

import { Button } from '@/components/Button';
import { Navbar } from '@/components/Navbar';
import { PageCardShell } from '@/components/PageCardShell';
import { useUserStore } from '@/stores/userStore';

import styles from './page.module.scss';

type AccountContentProps = {
  isLoggingOut: boolean;
  onLogout: () => void;
};

const AccountContent = ({
  isLoggingOut,
  onLogout,
}: AccountContentProps): JSX.Element => (
  <div className={styles.content}>
    <div className={styles.actions} aria-label="Account actions">
      <div className={styles.actionCopy}>
        <p className={styles.actionTitle}>Session controls</p>
        <p className={styles.actionHint}>
          Use logout to leave the workspace securely. You can sign back in
          anytime.
        </p>
      </div>
      <Button
        className={styles.logoutButton}
        displayStyle="dangerGhost"
        clickStyle="flat"
        disabled={isLoggingOut}
        onClick={onLogout}
      >
        {isLoggingOut ? 'Logging out...' : 'Log out'}
      </Button>
    </div>
  </div>
);

const AccountPage = (): JSX.Element | null => {
  const router = useRouter();
  const token = useUserStore((state) => state.token);
  const hasHydrated = useUserStore((state) => state.hasHydrated);
  const clearToken = useUserStore((state) => state.clearToken);

  const [isLoggingOut, setIsLoggingOut] = useState(false);

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

  if (!token && !isLoggingOut) {
    return null;
  }

  const handleLogout = (): void => {
    if (isLoggingOut) {
      return;
    }

    setIsLoggingOut(true);
    clearToken();
    router.replace('/');
  };

  return (
    <PageCardShell
      cardAriaLabel="Account overview"
      cardAriaLabelledBy="account-title"
      eyebrow="Account"
      headingId="account-title"
      header={<Navbar />}
      mainAriaLabel="Account page"
      subtitle="Keep your workspace secure. Sign out when you're wrapping up or switching devices."
      title="Your account"
    >
      <AccountContent isLoggingOut={isLoggingOut} onLogout={handleLogout} />
    </PageCardShell>
  );
};

export default AccountPage;
