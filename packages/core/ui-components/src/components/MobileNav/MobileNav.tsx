'use client';

import {
  type JSX,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import classnames from 'classnames';
import Link from 'next/link';

import styles from './MobileNav.module.scss';

type MobileNavProps = {
  links: Array<{ href: string; label: string }>;
  actions?: ReactNode;
  brandContent?: ReactNode;
  className?: string;
};

/**
 * MobileNav - Mobile navigation with hamburger menu
 *
 * Implements AC10.5: Navigation collapses to hamburger menu on mobile
 * Implements AC10.4: Touch targets minimum 44x44px
 */
const MobileNav = ({
  links,
  actions,
  brandContent,
  className,
}: MobileNavProps): JSX.Element => {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const hamburgerRef = useRef<HTMLButtonElement>(null);

  const openMenu = useCallback(() => {
    setIsOpen(true);
    document.body.style.overflow = 'hidden';
  }, []);

  const closeMenu = useCallback(() => {
    setIsOpen(false);
    document.body.style.overflow = '';
    hamburgerRef.current?.focus();
  }, []);

  const toggleMenu = useCallback(() => {
    if (isOpen) {
      closeMenu();
    } else {
      openMenu();
    }
  }, [isOpen, openMenu, closeMenu]);

  // Handle escape key
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && isOpen) {
        closeMenu();
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, closeMenu]);

  // Trap focus within menu when open
  useEffect(() => {
    if (!isOpen || !menuRef.current) return;

    const menu = menuRef.current;
    const focusableElements = menu.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];

    const handleTabKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return;

      if (event.shiftKey) {
        if (document.activeElement === firstElement) {
          event.preventDefault();
          lastElement?.focus();
        }
      } else if (document.activeElement === lastElement) {
        event.preventDefault();
        firstElement?.focus();
      }
    };

    document.addEventListener('keydown', handleTabKey);
    firstElement?.focus();

    return () => document.removeEventListener('keydown', handleTabKey);
  }, [isOpen]);

  return (
    <div className={className}>
      {/* Hamburger button - visible only on mobile */}
      <button
        ref={hamburgerRef}
        type="button"
        className={styles.hamburgerButton}
        onClick={toggleMenu}
        aria-expanded={isOpen}
        aria-controls="mobile-menu"
        aria-label={isOpen ? 'Close menu' : 'Open menu'}
      >
        <span className={styles.hamburgerIcon}>
          <span className={styles.hamburgerBar} />
          <span className={styles.hamburgerBar} />
          <span className={styles.hamburgerBar} />
        </span>
      </button>

      {/* Desktop navigation - visible only on desktop */}
      <nav className={styles.desktopNav} aria-label="Primary navigation">
        <ul style={{ display: 'flex', gap: '1.5rem', listStyle: 'none', margin: 0, padding: 0 }}>
          {links.map((link) => (
            <li key={link.href}>
              <Link href={link.href}>{link.label}</Link>
            </li>
          ))}
        </ul>
        {actions}
      </nav>

      {/* Mobile menu overlay */}
      <div
        className={classnames(styles.mobileMenuOverlay, { [styles.open!]: isOpen })}
        onClick={closeMenu}
        aria-hidden="true"
      />

      {/* Mobile menu panel */}
      <div
        ref={menuRef}
        id="mobile-menu"
        className={classnames(styles.mobileMenu, { [styles.open!]: isOpen })}
        role="dialog"
        aria-modal="true"
        aria-label="Mobile navigation"
      >
        <div className={styles.mobileMenuHeader}>
          {brandContent}
          <button
            type="button"
            className={styles.closeButton}
            onClick={closeMenu}
            aria-label="Close menu"
          >
            &times;
          </button>
        </div>

        <nav>
          <ul className={styles.mobileMenuNav}>
            {links.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  className={styles.mobileMenuLink}
                  onClick={closeMenu}
                >
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        {actions && (
          <div className={styles.mobileMenuActions}>
            {actions}
          </div>
        )}
      </div>
    </div>
  );
};

// Separate component for the hamburger button only
type HamburgerButtonProps = {
  isOpen: boolean;
  onClick: () => void;
  className?: string;
};

const HamburgerButton = ({
  isOpen,
  onClick,
  className,
}: HamburgerButtonProps): JSX.Element => {
  return (
    <button
      type="button"
      className={classnames(styles.hamburgerButton, className)}
      onClick={onClick}
      aria-expanded={isOpen}
      aria-label={isOpen ? 'Close menu' : 'Open menu'}
      style={{ display: 'flex' }} // Override responsive hiding for standalone use
    >
      <span className={styles.hamburgerIcon}>
        <span className={styles.hamburgerBar} />
        <span className={styles.hamburgerBar} />
        <span className={styles.hamburgerBar} />
      </span>
    </button>
  );
};

export { MobileNav, HamburgerButton };
export type { MobileNavProps, HamburgerButtonProps };
