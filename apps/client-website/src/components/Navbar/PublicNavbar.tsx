import Image from 'next/image';
import Link from 'next/link';
import type { JSX } from 'react';

import { Button } from '@/components/Button';

import styles from './Navbar.module.scss';

const PublicNavbar = (): JSX.Element => {
  return (
    <nav className={styles.navbar} aria-label="Primary navigation">
      <Link className={styles.brandLink} href="/">
        <div className={styles.brand}>
          <div className={styles.logo} aria-hidden="true">
            {/* TODO: Add light mode support */}
            <Image
              src="/logo-dark.png"
              alt="Brand Logo"
              width={32}
              height={32}
            />
          </div>
          <span>The Monorepo</span>
        </div>
      </Link>

      <ul className={styles.links}>
        <li>
          <Link href="/features">Features</Link>
        </li>
      </ul>

      <div className={styles.actions}>
        <Button
          className={styles.navButton}
          displayStyle="secondary"
          clickStyle="flat"
          href="/login"
        >
          Log in
        </Button>
        <Button
          className={styles.navButton}
          displayStyle="cta"
          clickStyle="3d"
          href="/signup"
        >
          Get started
        </Button>
      </div>
    </nav>
  );
};

export { PublicNavbar };
