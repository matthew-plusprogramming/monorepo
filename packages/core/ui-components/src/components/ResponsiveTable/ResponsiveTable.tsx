'use client';

import {
  type JSX,
  type ReactNode,
  type TableHTMLAttributes,
  type TdHTMLAttributes,
  type ThHTMLAttributes,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import classnames from 'classnames';

import styles from './ResponsiveTable.module.scss';

type ResponsiveTableWrapperProps = {
  children: ReactNode;
  className?: string;
  showScrollShadows?: boolean;
};

/**
 * ResponsiveTableWrapper - Wrapper for tables that scroll horizontally on mobile
 *
 * Implements AC10.6: Tables scroll horizontally on mobile rather than breaking layout
 */
const ResponsiveTableWrapper = ({
  children,
  className,
  showScrollShadows = true,
}: ResponsiveTableWrapperProps): JSX.Element => {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateScrollState = useCallback(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    const { scrollLeft, scrollWidth, clientWidth } = wrapper;
    setCanScrollLeft(scrollLeft > 0);
    setCanScrollRight(scrollLeft + clientWidth < scrollWidth - 1);
  }, []);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    updateScrollState();

    const resizeObserver = new ResizeObserver(updateScrollState);
    resizeObserver.observe(wrapper);

    wrapper.addEventListener('scroll', updateScrollState, { passive: true });

    return () => {
      resizeObserver.disconnect();
      wrapper.removeEventListener('scroll', updateScrollState);
    };
  }, [updateScrollState]);

  return (
    <div
      ref={wrapperRef}
      className={classnames(
        styles.tableWrapper,
        showScrollShadows && styles.tableWrapperWithShadows,
        canScrollLeft && styles.canScrollLeft,
        canScrollRight && styles.canScrollRight,
        className,
      )}
      role="region"
      aria-label="Scrollable table"
      tabIndex={0}
    >
      {children}
    </div>
  );
};

type ResponsiveTableProps = TableHTMLAttributes<HTMLTableElement> & {
  children: ReactNode;
  variant?: 'default' | 'compact' | 'striped';
};

/**
 * ResponsiveTable - Table component with responsive styling
 */
const ResponsiveTable = ({
  children,
  className,
  variant = 'default',
  ...props
}: ResponsiveTableProps): JSX.Element => {
  return (
    <table
      className={classnames(
        styles.table,
        variant === 'compact' && styles.compactTable,
        variant === 'striped' && styles.stripedTable,
        className,
      )}
      {...props}
    >
      {children}
    </table>
  );
};

type TableRowProps = {
  children: ReactNode;
  className?: string;
};

const TableRow = ({ children, className }: TableRowProps): JSX.Element => {
  return <tr className={classnames(styles.tr, className)}>{children}</tr>;
};

type TableHeaderCellProps = ThHTMLAttributes<HTMLTableCellElement> & {
  children: ReactNode;
};

const TableHeaderCell = ({
  children,
  className,
  ...props
}: TableHeaderCellProps): JSX.Element => {
  return (
    <th className={classnames(styles.th, className)} {...props}>
      {children}
    </th>
  );
};

type TableCellProps = TdHTMLAttributes<HTMLTableCellElement> & {
  children: ReactNode;
};

const TableCell = ({
  children,
  className,
  ...props
}: TableCellProps): JSX.Element => {
  return (
    <td className={classnames(styles.td, className)} {...props}>
      {children}
    </td>
  );
};

type TableCellButtonProps = {
  children: ReactNode;
  onClick?: () => void;
  className?: string;
  'aria-label'?: string;
};

/**
 * TableCellButton - Touch-friendly button for table actions
 *
 * Implements AC10.4: Touch targets minimum 44x44px
 */
const TableCellButton = ({
  children,
  onClick,
  className,
  'aria-label': ariaLabel,
}: TableCellButtonProps): JSX.Element => {
  return (
    <button
      type="button"
      className={classnames(styles.cellButton, className)}
      onClick={onClick}
      aria-label={ariaLabel}
    >
      {children}
    </button>
  );
};

export {
  ResponsiveTableWrapper,
  ResponsiveTable,
  TableRow,
  TableHeaderCell,
  TableCell,
  TableCellButton,
};
export type {
  ResponsiveTableWrapperProps,
  ResponsiveTableProps,
  TableRowProps,
  TableHeaderCellProps,
  TableCellProps,
  TableCellButtonProps,
};
