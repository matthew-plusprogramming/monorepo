import type { JSX } from 'react';

import styles from './Navbar.module.scss';

const Navbar = (): JSX.Element => {
  return (
    <nav className={styles.navbar} aria-label="Primary navigation">
      <div className={styles.brand}>
        <div className={styles.logo} aria-hidden="true">
          Logo
        </div>
        <span className={styles.brandName}>Brand Name</span>
      </div>

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

export default Navbar;
