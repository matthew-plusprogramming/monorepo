'use client';

import type { JSX } from 'react';

import { Navbar } from '@/components/Navbar';
import { PageCardShell } from '@/components/PageCardShell';
import { useProtectedPage } from '@/hooks/useProtectedPage';

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
      <></>
    </PageCardShell>
  );
};

export default HomePage;
