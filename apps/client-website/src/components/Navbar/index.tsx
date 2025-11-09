import Image from 'next/image';
import Link from 'next/link';
import type { JSX } from 'react';

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
          <span>Brand Name</span>
        </div>
      </Link>

      <ul className={styles.links}>
        <li>
          <a href="#features">Features</a>
        </li>
        <li>
          <a href="#pricing">Pricing</a>
        </li>
        <li>
          <a href="#blog">Blog</a>
        </li>
      </ul>

      <div className={styles.actions}>
        <button className={styles.secondaryButton} type="button">
          Log in
        </button>
        <button className={styles.primaryButton} type="button">
          Get started
        </button>
      </div>
    </nav>
  );
};

export { Navbar };
