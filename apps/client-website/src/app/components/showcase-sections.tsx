import type { JSX } from 'react';

import { Button, type ButtonProps } from '@/components/Button';
import { DropdownMenu, type DropdownMenuItem } from '@/components/DropdownMenu';

import styles from './page.module.scss';

type ButtonDisplayStyle = NonNullable<ButtonProps['displayStyle']>;
type ButtonClickStyle = NonNullable<ButtonProps['clickStyle']>;
type ButtonSize = NonNullable<ButtonProps['size']>;

const buttonDisplayOptions: Array<{
  value: ButtonDisplayStyle;
  label: string;
  description: string;
}> = [
  {
    value: 'cta',
    label: 'CTA',
    description: 'Primary action with accent color and depth.',
  },
  {
    value: 'secondary',
    label: 'Secondary',
    description: 'Supporting action with balanced contrast.',
  },
  {
    value: 'ghost',
    label: 'Ghost',
    description: 'Low-emphasis outline for subtle actions.',
  },
  {
    value: 'dangerGhost',
    label: 'Danger',
    description: 'Destructive or high-attention choice.',
  },
];

const clickStyleOptions: Array<{ value: ButtonClickStyle; label: string }> = [
  { value: '3d', label: '3D' },
  { value: 'flat', label: 'Flat' },
];

const sizeOptions: Array<{ value: ButtonSize; label: string }> = [
  { value: 'md', label: 'Medium' },
  { value: 'sm', label: 'Small' },
];

type ButtonControlsProps = {
  clickStyle: ButtonClickStyle;
  onClickStyleChange: (style: ButtonClickStyle) => void;
  onSizeChange: (size: ButtonSize) => void;
  size: ButtonSize;
};

const ButtonControls = ({
  clickStyle,
  onClickStyleChange,
  onSizeChange,
  size,
}: ButtonControlsProps): JSX.Element => {
  return (
    <div className={styles.controls}>
      <div
        aria-label="Choose button click style"
        className={styles.controlGroup}
        role="group"
      >
        <p className={styles.controlLabel}>Click style</p>
        <div className={styles.pillRow}>
          {clickStyleOptions.map((option) => (
            <button
              aria-pressed={clickStyle === option.value}
              className={`${styles.pillButton} ${
                clickStyle === option.value ? styles.pillButtonActive : ''
              }`}
              key={option.value}
              onClick={(): void => {
                onClickStyleChange(option.value);
              }}
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div
        aria-label="Choose button size"
        className={styles.controlGroup}
        role="group"
      >
        <p className={styles.controlLabel}>Size</p>
        <div className={styles.pillRow}>
          {sizeOptions.map((option) => (
            <button
              aria-pressed={size === option.value}
              className={`${styles.pillButton} ${
                size === option.value ? styles.pillButtonActive : ''
              }`}
              key={option.value}
              onClick={(): void => {
                onSizeChange(option.value);
              }}
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

type ButtonGridProps = {
  clickStyle: ButtonClickStyle;
  size: ButtonSize;
};

const ButtonGrid = ({ clickStyle, size }: ButtonGridProps): JSX.Element => {
  return (
    <div className={styles.buttonGrid} role="list">
      {buttonDisplayOptions.map((option) => (
        <div className={styles.buttonCard} key={option.value} role="listitem">
          <div className={styles.variantHeader}>
            <p className={styles.variantLabel}>{option.label}</p>
            <p className={styles.variantDescription}>{option.description}</p>
          </div>
          <Button
            clickStyle={clickStyle}
            displayStyle={option.value}
            size={size}
          >
            {option.label} button
          </Button>
        </div>
      ))}
    </div>
  );
};

type ButtonActionsProps = {
  clickStyle: ButtonClickStyle;
  onReset: () => void;
  onSuccessToast: () => void;
};

const ButtonActions = ({
  clickStyle,
  onReset,
  onSuccessToast,
}: ButtonActionsProps): JSX.Element => {
  return (
    <div className={styles.demoActions}>
      <p className={styles.controlLabel}>Try a toast</p>
      <Button
        displayStyle="cta"
        clickStyle={clickStyle}
        onClick={onSuccessToast}
        size="sm"
      >
        Show success toast
      </Button>
      <Button
        displayStyle="ghost"
        clickStyle="flat"
        onClick={onReset}
        size="sm"
      >
        Reset button settings
      </Button>
    </div>
  );
};

type ButtonShowcaseProps = {
  clickStyle: ButtonClickStyle;
  onClickStyleChange: (style: ButtonClickStyle) => void;
  onReset: () => void;
  onSizeChange: (size: ButtonSize) => void;
  onSuccessToast: () => void;
  size: ButtonSize;
};

const ButtonShowcase = ({
  clickStyle,
  onClickStyleChange,
  onReset,
  onSizeChange,
  onSuccessToast,
  size,
}: ButtonShowcaseProps): JSX.Element => {
  return (
    <section className={styles.section} aria-labelledby="button-gallery">
      <div className={styles.sectionHeader}>
        <p className={styles.sectionEyebrow}>Buttons</p>
        <div>
          <h2 className={styles.sectionTitle} id="button-gallery">
            Try every Button look
          </h2>
          <p className={styles.sectionDescription}>
            Toggle click style and size to see how each display style adapts.
            All examples stay on this page so you can compare side by side.
          </p>
        </div>
      </div>

      <ButtonControls
        clickStyle={clickStyle}
        onClickStyleChange={onClickStyleChange}
        onSizeChange={onSizeChange}
        size={size}
      />
      <ButtonGrid clickStyle={clickStyle} size={size} />
      <ButtonActions
        clickStyle={clickStyle}
        onReset={onReset}
        onSuccessToast={onSuccessToast}
      />
    </section>
  );
};

type DropdownShowcaseProps = {
  isOpen: boolean;
  onClose: () => void;
  onError: () => void;
  onSuccess: () => void;
  onToggle: () => void;
};

const DropdownShowcase = ({
  isOpen,
  onClose,
  onError,
  onSuccess,
  onToggle,
}: DropdownShowcaseProps): JSX.Element => {
  const dropdownItems: DropdownMenuItem[] = [
    {
      label: 'Trigger success toast',
      onClick: (): void => {
        onSuccess();
      },
    },
    {
      label: 'Trigger error toast',
      className: styles.destructiveItem,
      onClick: (): void => {
        onError();
      },
    },
    { label: 'Disabled item', disabled: true, onClick: (): void => {} },
  ];

  return (
    <section className={styles.section} aria-labelledby="dropdown-demo">
      <div className={styles.sectionHeader}>
        <p className={styles.sectionEyebrow}>Dropdown</p>
        <div>
          <h2 className={styles.sectionTitle} id="dropdown-demo">
            Interact with the DropdownMenu
          </h2>
          <p className={styles.sectionDescription}>
            Open the menu to trigger different actions. One item shows a success
            toast, another shows an error toast, and a disabled item
            demonstrates a blocked path.
          </p>
        </div>
      </div>

      <div className={styles.dropdownRow}>
        <DropdownMenu
          isOpen={isOpen}
          items={dropdownItems}
          onClose={onClose}
          onToggle={onToggle}
          panelClassName={styles.dropdownPanel}
          triggerAriaLabel="Open dropdown demo"
          triggerClassName={styles.dropdownTrigger}
          triggerContent="Open menu"
          wrapperClassName={styles.dropdownWrapper}
        />
        <p className={styles.dropdownHint}>
          Choose an item to fire a toast. Disabled options stay inert but keep
          focus styles.
        </p>
      </div>
    </section>
  );
};

export type { ButtonClickStyle, ButtonDisplayStyle, ButtonSize };
export { ButtonShowcase, DropdownShowcase };
