import type { JSX } from 'react';

import { PublicNavbar } from '@/components/Navbar';
import { PageCardShell } from '@/components/PageCardShell';

import styles from './page.module.scss';

const ComponentsPage = (): JSX.Element => {
  return (
    <PageCardShell
      cardAriaLabel="Component highlights"
      cardAriaLabelledBy="components-title"
      eyebrow="Components"
      headingId="components-title"
      header={<PublicNavbar />}
      mainAriaLabel="Components page"
      subtitle="Browse the components that ship with this monorepo. Each piece is typed, styled, and ready to drop into both marketing and product flows."
      title="Build pages with reusable UI primitives"
    >
      <></>
    </PageCardShell>
  );
};

export default ComponentsPage;
