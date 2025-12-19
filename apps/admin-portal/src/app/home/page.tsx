'use client';

import { Navbar, PageCardShell } from '@ui/components';
import type { JSX } from 'react';

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
