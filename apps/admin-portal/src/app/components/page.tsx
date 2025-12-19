'use client';
import { type JSX, useState } from 'react';

import {
  PageCardShell,
  PublicNavbar,
  Toast,
  type ToastProps,
} from '@ui/components';

import {
  type ButtonClickStyle,
  ButtonShowcase,
  type ButtonSize,
  DropdownShowcase,
} from './showcase-sections';

import styles from './page.module.scss';

type ToastVariant = NonNullable<ToastProps['variant']>;

type ToastState = {
  message: string;
  variant: ToastVariant;
};

const ComponentsPage = (): JSX.Element => {
  const [clickStyle, setClickStyle] = useState<ButtonClickStyle>('3d');
  const [size, setSize] = useState<ButtonSize>('md');
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);

  const showToast = (variant: ToastVariant, message: string): void => {
    setToast({ variant, message });
  };
  const dismissToast = (): void => {
    setToast(null);
  };
  const resetButtons = (): void => {
    setClickStyle('3d');
    setSize('md');
  };
  const handleButtonSuccessToast = (): void => {
    showToast('success', 'Success toast triggered from the button demo.');
  };
  const handleDropdownSuccess = (): void => {
    showToast('success', 'Saved action from the dropdown.');
  };
  const handleDropdownError = (): void => {
    showToast('error', 'Something went wrong in the dropdown action.');
  };
  const handleDropdownToggle = (): void => {
    setIsDropdownOpen((open) => !open);
  };
  const handleDropdownClose = (): void => {
    setIsDropdownOpen(false);
  };

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
      <div className={styles.layout}>
        <ButtonShowcase
          clickStyle={clickStyle}
          onClickStyleChange={setClickStyle}
          onReset={resetButtons}
          onSizeChange={setSize}
          onSuccessToast={handleButtonSuccessToast}
          size={size}
        />

        <DropdownShowcase
          isOpen={isDropdownOpen}
          onClose={handleDropdownClose}
          onError={handleDropdownError}
          onSuccess={handleDropdownSuccess}
          onToggle={handleDropdownToggle}
        />
      </div>

      {toast ? (
        <Toast
          message={toast.message}
          onDismiss={dismissToast}
          variant={toast.variant}
        />
      ) : null}
    </PageCardShell>
  );
};

export default ComponentsPage;
