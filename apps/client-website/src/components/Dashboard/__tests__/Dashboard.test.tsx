import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { ListProjectsResponse, Project } from '@/lib/api/projects';

const mockPush = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
  }),
}));

// Mock the projects API
const mockFetchProjects = vi.fn();
vi.mock('@/lib/api/projects', () => ({
  fetchProjects: () => mockFetchProjects(),
}));

import { Dashboard } from '../Dashboard';

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

const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
};

describe('Dashboard', () => {
  beforeEach(() => {
    mockFetchProjects.mockClear();
    mockPush.mockClear();
  });

  describe('AC1.1: Dashboard displays all projects as cards with name and status', () => {
    it('renders project cards with names', async () => {
      const mockResponse: ListProjectsResponse = {
        projects: [
          createMockProject({ id: '1', name: 'Project Alpha' }),
          createMockProject({ id: '2', name: 'Project Beta' }),
        ],
        total: 2,
      };
      mockFetchProjects.mockResolvedValue(mockResponse);

      render(<Dashboard enablePolling={false} />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.getByText('Project Alpha')).toBeInTheDocument();
        expect(screen.getByText('Project Beta')).toBeInTheDocument();
      });
    });

    it('renders project status indicators', async () => {
      const mockResponse: ListProjectsResponse = {
        projects: [createMockProject({ status: 'active' })],
        total: 1,
      };
      mockFetchProjects.mockResolvedValue(mockResponse);

      render(<Dashboard enablePolling={false} />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.getByText('active')).toBeInTheDocument();
      });
    });
  });

  describe('AC1.2: Each project card shows spec group count', () => {
    it('displays spec group count for each project', async () => {
      const mockResponse: ListProjectsResponse = {
        projects: [
          createMockProject({ id: '1', specGroupCount: 5 }),
          createMockProject({ id: '2', specGroupCount: 1 }),
        ],
        total: 2,
      };
      mockFetchProjects.mockResolvedValue(mockResponse);

      render(<Dashboard enablePolling={false} />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.getByText('5 spec groups')).toBeInTheDocument();
        expect(screen.getByText('1 spec group')).toBeInTheDocument();
      });
    });
  });

  describe('AC1.3: Each project card shows health indicator', () => {
    it('displays health indicators for each project', async () => {
      const mockResponse: ListProjectsResponse = {
        projects: [
          createMockProject({ id: '1', health: 'green' }),
          createMockProject({ id: '2', health: 'yellow' }),
          createMockProject({ id: '3', health: 'red' }),
        ],
        total: 3,
      };
      mockFetchProjects.mockResolvedValue(mockResponse);

      render(<Dashboard enablePolling={false} />, { wrapper: createWrapper() });

      await waitFor(() => {
        const healthIndicators = screen.getAllByRole('status', { name: /health/i });
        expect(healthIndicators).toHaveLength(3);
      });
    });

    it('displays health summary stats', async () => {
      const mockResponse: ListProjectsResponse = {
        projects: [
          createMockProject({ id: '1', health: 'green' }),
          createMockProject({ id: '2', health: 'green' }),
          createMockProject({ id: '3', health: 'yellow' }),
          createMockProject({ id: '4', health: 'red' }),
        ],
        total: 4,
      };
      mockFetchProjects.mockResolvedValue(mockResponse);

      render(<Dashboard enablePolling={false} />, { wrapper: createWrapper() });

      await waitFor(() => {
        // Check for the stat values (2 healthy, 1 in progress, 1 blocked)
        expect(screen.getByText('Healthy')).toBeInTheDocument();
        expect(screen.getByText('In Progress')).toBeInTheDocument();
        expect(screen.getByText('Blocked')).toBeInTheDocument();
      });
    });
  });

  describe('AC1.4: Projects load within 3 seconds on initial page load', () => {
    it('shows loading skeletons while fetching', async () => {
      // Create a promise that we control
      let resolvePromise: (value: ListProjectsResponse) => void;
      const fetchPromise = new Promise<ListProjectsResponse>((resolve) => {
        resolvePromise = resolve;
      });
      mockFetchProjects.mockReturnValue(fetchPromise);

      render(<Dashboard enablePolling={false} />, { wrapper: createWrapper() });

      // Should show loading state
      expect(screen.getByText('Loading projects...')).toBeInTheDocument();
      expect(screen.getAllByLabelText('Loading project')).toHaveLength(6);

      // Resolve the promise
      resolvePromise!({ projects: [], total: 0 });

      await waitFor(() => {
        expect(screen.queryByText('Loading projects...')).not.toBeInTheDocument();
      });
    });
  });

  describe('AC1.5: Status indicators update in real-time without page refresh', () => {
    it('shows auto-updating indicator when polling is enabled', async () => {
      const mockResponse: ListProjectsResponse = {
        projects: [createMockProject()],
        total: 1,
      };
      mockFetchProjects.mockResolvedValue(mockResponse);

      render(<Dashboard enablePolling pollingInterval={5000} />, {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(screen.getByText('Auto-updating every 5s')).toBeInTheDocument();
      });
    });

    it('hides auto-updating indicator when polling is disabled', async () => {
      const mockResponse: ListProjectsResponse = {
        projects: [createMockProject()],
        total: 1,
      };
      mockFetchProjects.mockResolvedValue(mockResponse);

      render(<Dashboard enablePolling={false} />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.getByText('Test Project')).toBeInTheDocument();
      });

      expect(screen.queryByText(/Auto-updating/i)).not.toBeInTheDocument();
    });
  });

  describe('Loading state', () => {
    it('displays skeleton cards during initial load', () => {
      mockFetchProjects.mockReturnValue(new Promise(() => {}));

      render(<Dashboard enablePolling={false} />, { wrapper: createWrapper() });

      const skeletons = screen.getAllByLabelText('Loading project');
      expect(skeletons.length).toBeGreaterThan(0);
    });
  });

  describe('Empty state', () => {
    it('displays empty state when no projects exist', async () => {
      mockFetchProjects.mockResolvedValue({ projects: [], total: 0 });

      render(<Dashboard enablePolling={false} />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.getByText('No projects yet')).toBeInTheDocument();
        expect(
          screen.getByText('Projects will appear here once spec groups are created.'),
        ).toBeInTheDocument();
      });
    });
  });

  describe('Error state', () => {
    it('displays error message when fetch fails', async () => {
      mockFetchProjects.mockImplementation(() => {
        return Promise.reject(new Error('Network error'));
      });

      render(<Dashboard enablePolling={false} />, { wrapper: createWrapper() });

      await waitFor(
        () => {
          expect(screen.getByText('Failed to load projects')).toBeInTheDocument();
          expect(screen.getByText('Network error')).toBeInTheDocument();
        },
        { timeout: 3000 },
      );
    });

    it('displays retry button on error', async () => {
      mockFetchProjects.mockImplementation(() => {
        return Promise.reject(new Error('Network error'));
      });

      render(<Dashboard enablePolling={false} />, { wrapper: createWrapper() });

      await waitFor(
        () => {
          expect(screen.getByRole('button', { name: 'Try Again' })).toBeInTheDocument();
        },
        { timeout: 3000 },
      );
    });
  });

  describe('Project count display', () => {
    it('shows correct project count', async () => {
      const mockResponse: ListProjectsResponse = {
        projects: [
          createMockProject({ id: '1' }),
          createMockProject({ id: '2' }),
          createMockProject({ id: '3' }),
        ],
        total: 3,
      };
      mockFetchProjects.mockResolvedValue(mockResponse);

      render(<Dashboard enablePolling={false} />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.getByText('3 projects')).toBeInTheDocument();
      });
    });

    it('shows singular form for one project', async () => {
      const mockResponse: ListProjectsResponse = {
        projects: [createMockProject()],
        total: 1,
      };
      mockFetchProjects.mockResolvedValue(mockResponse);

      render(<Dashboard enablePolling={false} />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.getByText('1 project')).toBeInTheDocument();
      });
    });
  });
});
