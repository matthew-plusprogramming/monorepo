import { type JSX, type ReactNode, useId } from 'react';

import { AnimatePresence, motion } from 'framer-motion';

import styles from './DropdownMenu.module.scss';

const classNames = (...values: Array<string | undefined>): string =>
  values.filter((value): value is string => Boolean(value)).join(' ');

type DropdownMenuItem = {
  id?: string;
  label: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
  closeOnClick?: boolean;
};

type DropdownMenuProps = {
  isOpen: boolean;
  onToggle: () => void;
  onClose: () => void;
  triggerAriaLabel: string;
  triggerContent: ReactNode;
  items: DropdownMenuItem[];
  panelId?: string;
  triggerClassName?: string;
  panelClassName?: string;
  wrapperClassName?: string;
};

const DropdownMenu = ({
  isOpen,
  onToggle,
  onClose,
  triggerAriaLabel,
  triggerContent,
  items,
  panelId,
  triggerClassName,
  panelClassName,
  wrapperClassName,
}: DropdownMenuProps): JSX.Element => {
  const generatedId = useId();
  const menuId = panelId ?? generatedId;

  return (
    <div className={classNames(styles.menuWrapper, wrapperClassName)}>
      <button
        aria-controls={menuId}
        aria-expanded={isOpen}
        aria-label={triggerAriaLabel}
        className={classNames(styles.menuButton, triggerClassName)}
        onClick={onToggle}
        type="button"
      >
        {triggerContent}
      </button>
      <AnimatePresence>
        {isOpen ? (
          <motion.div
            animate={{ opacity: 1, scale: 1, y: 0 }}
            className={classNames(styles.menuPanel, panelClassName)}
            exit={{ opacity: 0, scale: 0.96, y: -4 }}
            initial={{ opacity: 0, scale: 0.95, y: -6 }}
            id={menuId}
          >
            {items.map((item, index) => (
              <button
                className={classNames(styles.menuItem, item.className)}
                disabled={item.disabled}
                key={item.id ?? index}
                onClick={() => {
                  if (item.disabled) {
                    return;
                  }

                  item.onClick();

                  if (item.closeOnClick !== false) {
                    onClose();
                  }
                }}
                type="button"
              >
                {item.label}
              </button>
            ))}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
};

export type { DropdownMenuItem, DropdownMenuProps };
export { DropdownMenu };
