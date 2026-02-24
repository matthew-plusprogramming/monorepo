/**
 * Projects API Client Tests (AS-002)
 *
 * Validates that dynamic URL path segments are properly encoded
 * with encodeURIComponent to prevent URL corruption and path traversal.
 *
 * AC2.1: fetchProject(id) wraps id in encodeURIComponent()
 * AC2.3: IDs with special characters (/, ?, #, %) are safely encoded
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { fetchProject, fetchProjects } from '../projects';

// Capture fetch calls to inspect constructed URLs
const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('NEXT_PUBLIC_API_URL', 'http://test-api.example.com');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const createSuccessResponse = (body: unknown): Response =>
  ({
    ok: true,
    json: async () => body,
    clone: () => createSuccessResponse(body),
    text: async () => JSON.stringify(body),
  }) as unknown as Response;

const mockProject = {
  id: 'proj-1',
  name: 'Test Project',
  status: 'active',
  health: 'green',
  specGroupCount: 0,
  specGroupSummary: {
    total: 0,
    byState: {},
    allGatesPassed: 0,
    criticalGatesFailed: 0,
  },
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
};

describe('Projects API - URL Encoding (AS-002)', () => {
  describe('fetchProject with encodeURIComponent (AC2.1)', () => {
    it('should encode forward slashes in project IDs (AC2.1, AC2.3)', async () => {
      // Arrange
      fetchMock.mockResolvedValueOnce(createSuccessResponse(mockProject));
      const idWithSlashes = 'id/with/slashes';

      // Act
      await fetchProject(idWithSlashes);

      // Assert
      const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
      expect(calledUrl).toContain('id%2Fwith%2Fslashes');
      expect(calledUrl).not.toContain('id/with/slashes');
    });

    it('should encode question marks in project IDs (AC2.3)', async () => {
      // Arrange
      fetchMock.mockResolvedValueOnce(createSuccessResponse(mockProject));
      const idWithQuestion = 'project?query=value';

      // Act
      await fetchProject(idWithQuestion);

      // Assert
      const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
      expect(calledUrl).toContain('project%3Fquery%3Dvalue');
    });

    it('should encode hash symbols in project IDs (AC2.3)', async () => {
      // Arrange
      fetchMock.mockResolvedValueOnce(createSuccessResponse(mockProject));
      const idWithHash = 'project#section';

      // Act
      await fetchProject(idWithHash);

      // Assert
      const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
      expect(calledUrl).toContain('project%23section');
    });

    it('should encode percent signs in project IDs (AC2.3)', async () => {
      // Arrange
      fetchMock.mockResolvedValueOnce(createSuccessResponse(mockProject));
      const idWithPercent = 'project%20name';

      // Act
      await fetchProject(idWithPercent);

      // Assert
      const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
      expect(calledUrl).toContain('project%2520name');
    });

    it('should encode spaces in project IDs (AC2.3)', async () => {
      // Arrange
      fetchMock.mockResolvedValueOnce(createSuccessResponse(mockProject));
      const idWithSpaces = 'project name with spaces';

      // Act
      await fetchProject(idWithSpaces);

      // Assert
      const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
      expect(calledUrl).toContain('project%20name%20with%20spaces');
    });

    it('should encode combination of special characters (AC2.3)', async () => {
      // Arrange
      fetchMock.mockResolvedValueOnce(createSuccessResponse(mockProject));
      const complexId = 'a?b#c%d/e';

      // Act
      await fetchProject(complexId);

      // Assert
      const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
      expect(calledUrl).toContain(encodeURIComponent(complexId));
    });

    it('should leave normal alphanumeric IDs unchanged (AC2.1)', async () => {
      // Arrange
      fetchMock.mockResolvedValueOnce(createSuccessResponse(mockProject));
      const normalId = 'proj-abc-123';

      // Act
      await fetchProject(normalId);

      // Assert
      const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
      expect(calledUrl).toBe(
        `http://test-api.example.com/api/projects/${normalId}`,
      );
    });

    it('should construct the full URL correctly with encoding (AC2.1)', async () => {
      // Arrange
      fetchMock.mockResolvedValueOnce(createSuccessResponse(mockProject));
      const idWithSlash = 'org/project';

      // Act
      await fetchProject(idWithSlash);

      // Assert
      const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
      expect(calledUrl).toBe(
        `http://test-api.example.com/api/projects/${encodeURIComponent(idWithSlash)}`,
      );
    });
  });

  describe('fetchProjects uses static path (AC2.2)', () => {
    it('should use static path without dynamic segments (AC2.2)', async () => {
      // Arrange
      fetchMock.mockResolvedValueOnce(
        createSuccessResponse({ projects: [], total: 0 }),
      );

      // Act
      await fetchProjects();

      // Assert
      const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
      expect(calledUrl).toBe('http://test-api.example.com/api/projects');
    });
  });
});
