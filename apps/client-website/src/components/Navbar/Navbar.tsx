import Image from 'next/image';
import Link from 'next/link';
import type { JSX } from 'react';

import { Button } from '@/components/Button';

import styles from './Navbar.module.scss';

const Navbar = (): JSX.Element => {
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
          <Link href="#dashboard">Dashboard</Link>
        </li>
        <li>
          <Link href="#projects">Projects</Link>
        </li>
        <li>
          <Link href="#support">Support</Link>
        </li>
      </ul>

      <div className={styles.actions}>
        <Button
          className={styles.navButton}
          displayStyle="cta"
          clickStyle="3d"
          href="/account"
        >
          My Account
        </Button>
      </div>
    </nav>
  );
};

export { Navbar };
