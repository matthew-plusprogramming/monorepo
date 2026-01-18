import type { JSX, ReactNode } from 'react';

import classnames from 'classnames';

import styles from './ResponsiveGrid.module.scss';

type ResponsiveGridProps = {
  children: ReactNode;
  className?: string;
  withSidebar?: boolean;
};

/**
 * ResponsiveGrid - A responsive grid layout component
 *
 * Implements responsive breakpoints:
 * - AC10.1: Mobile (< 768px): single column, stacked panels
 * - AC10.2: Tablet (768px - 1024px): two column grid
 * - AC10.3: Desktop (> 1024px): three column grid with sidebar
 */
const ResponsiveGrid = ({
  children,
  className,
  withSidebar = false,
}: ResponsiveGridProps): JSX.Element => {
  return (
    <div
      className={classnames(
        withSidebar ? styles.responsiveGridWithSidebar : styles.responsiveGrid,
        className,
      )}
    >
      {children}
    </div>
  );
};

type GridSidebarProps = {
  children: ReactNode;
  className?: string;
};

const GridSidebar = ({ children, className }: GridSidebarProps): JSX.Element => {
  return (
    <aside className={classnames(styles.sidebar, className)}>
      {children}
    </aside>
  );
};

type GridMainContentProps = {
  children: ReactNode;
  className?: string;
};

const GridMainContent = ({
  children,
  className,
}: GridMainContentProps): JSX.Element => {
  return (
    <div className={classnames(styles.mainContent, className)}>
      {children}
    </div>
  );
};

type GridPanelProps = {
  children: ReactNode;
  className?: string;
};

const GridPanel = ({ children, className }: GridPanelProps): JSX.Element => {
  return (
    <div className={classnames(styles.panel, className)}>
      {children}
    </div>
  );
};

export { ResponsiveGrid, GridSidebar, GridMainContent, GridPanel };
export type { ResponsiveGridProps, GridSidebarProps, GridMainContentProps, GridPanelProps };
