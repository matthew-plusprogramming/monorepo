import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { Project } from '@/lib/api/projects';

import { ProjectCard, ProjectCardSkeleton } from '../ProjectCard';

const createMockProject = (overrides: Partial<Project> = {}): Project => ({
  id: 'test-project',
  name: 'Test Project',
  description: 'A test project description',
  status: 'active',
  health: 'green',
  specGroupCount: 3,
  specGroupSummary: {
    total: 3,
    byState: { MERGED: 2, IN_PROGRESS: 1 },
    allGatesPassed: 2,
    criticalGatesFailed: 0,
  },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...overrides,
});

describe('ProjectCard', () => {
  describe('AC1.1: Project name and status display', () => {
    it('renders project name correctly', () => {
      const project = createMockProject({ name: 'My Awesome Project' });
      render(<ProjectCard project={project} />);

      expect(screen.getByRole('heading', { name: 'My Awesome Project' })).toBeInTheDocument();
    });

    it('renders project status correctly', () => {
      const project = createMockProject({ status: 'active' });
      render(<ProjectCard project={project} />);

      expect(screen.getByText('active')).toBeInTheDocument();
    });

    it('renders archived status correctly', () => {
      const project = createMockProject({ status: 'archived' });
      render(<ProjectCard project={project} />);

      expect(screen.getByText('archived')).toBeInTheDocument();
    });

    it('renders draft status correctly', () => {
      const project = createMockProject({ status: 'draft' });
      render(<ProjectCard project={project} />);

      expect(screen.getByText('draft')).toBeInTheDocument();
    });
  });

  describe('AC1.2: Spec group count display', () => {
    it('displays spec group count correctly for multiple groups', () => {
      const project = createMockProject({ specGroupCount: 5 });
      render(<ProjectCard project={project} />);

      expect(screen.getByText('5 spec groups')).toBeInTheDocument();
    });

    it('displays singular form for one spec group', () => {
      const project = createMockProject({ specGroupCount: 1 });
      render(<ProjectCard project={project} />);

      expect(screen.getByText('1 spec group')).toBeInTheDocument();
    });

    it('displays "No spec groups" for zero count', () => {
      const project = createMockProject({ specGroupCount: 0 });
      render(<ProjectCard project={project} />);

      expect(screen.getByText('No spec groups')).toBeInTheDocument();
    });
  });

  describe('AC1.3: Health indicator display', () => {
    it('renders green health indicator with correct label', () => {
      const project = createMockProject({ health: 'green' });
      render(<ProjectCard project={project} />);

      const healthIndicator = screen.getByRole('status', { name: /health/i });
      expect(healthIndicator).toBeInTheDocument();
      expect(healthIndicator).toHaveAttribute('aria-label', 'Health: All gates pass');
    });

    it('renders yellow health indicator with correct label', () => {
      const project = createMockProject({ health: 'yellow' });
      render(<ProjectCard project={project} />);

      const healthIndicator = screen.getByRole('status', { name: /health/i });
      expect(healthIndicator).toHaveAttribute('aria-label', 'Health: Some gates pass');
    });

    it('renders red health indicator with correct label', () => {
      const project = createMockProject({ health: 'red' });
      render(<ProjectCard project={project} />);

      const healthIndicator = screen.getByRole('status', { name: /health/i });
      expect(healthIndicator).toHaveAttribute('aria-label', 'Health: Critical gates fail');
    });
  });

  describe('Accessibility', () => {
    it('has correct role and aria-label', () => {
      const project = createMockProject({ name: 'Test Project' });
      render(<ProjectCard project={project} />);

      const card = screen.getByRole('button', { name: 'Project: Test Project' });
      expect(card).toBeInTheDocument();
    });

    it('is focusable via keyboard', () => {
      const project = createMockProject();
      render(<ProjectCard project={project} />);

      const card = screen.getByRole('button');
      expect(card).toHaveAttribute('tabIndex', '0');
    });
  });

  describe('Interaction', () => {
    it('calls onClick when clicked', () => {
      const project = createMockProject();
      const onClick = vi.fn();
      render(<ProjectCard project={project} onClick={onClick} />);

      fireEvent.click(screen.getByRole('button'));
      expect(onClick).toHaveBeenCalledWith(project);
    });

    it('calls onClick when Enter key is pressed', () => {
      const project = createMockProject();
      const onClick = vi.fn();
      render(<ProjectCard project={project} onClick={onClick} />);

      fireEvent.keyDown(screen.getByRole('button'), { key: 'Enter' });
      expect(onClick).toHaveBeenCalledWith(project);
    });

    it('calls onClick when Space key is pressed', () => {
      const project = createMockProject();
      const onClick = vi.fn();
      render(<ProjectCard project={project} onClick={onClick} />);

      fireEvent.keyDown(screen.getByRole('button'), { key: ' ' });
      expect(onClick).toHaveBeenCalledWith(project);
    });

    it('does not throw when onClick is not provided', () => {
      const project = createMockProject();
      render(<ProjectCard project={project} />);

      expect(() => {
        fireEvent.click(screen.getByRole('button'));
      }).not.toThrow();
    });
  });

  describe('Description', () => {
    it('renders description when provided', () => {
      const project = createMockProject({ description: 'Test description' });
      render(<ProjectCard project={project} />);

      expect(screen.getByText('Test description')).toBeInTheDocument();
    });

    it('does not render description when not provided', () => {
      const project = createMockProject({ description: undefined });
      render(<ProjectCard project={project} />);

      expect(screen.queryByText(/description/i)).not.toBeInTheDocument();
    });
  });
});

describe('ProjectCardSkeleton', () => {
  it('renders loading skeleton', () => {
    render(<ProjectCardSkeleton />);

    expect(screen.getByLabelText('Loading project')).toBeInTheDocument();
  });

  it('has aria-busy attribute', () => {
    render(<ProjectCardSkeleton />);

    expect(screen.getByLabelText('Loading project')).toHaveAttribute('aria-busy', 'true');
  });
});
