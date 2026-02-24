/**
 * Projects API Client (AS-001)
 *
 * Client for fetching project data from the API.
 */

const DEFAULT_API_URL = 'http://localhost:3000';

/**
 * Health status for a project based on convergence gates (AC1.3).
 */
type ProjectHealth = 'green' | 'yellow' | 'red';

/**
 * Summary of spec groups within a project.
 */
type SpecGroupSummary = {
  readonly total: number;
  readonly byState: Record<string, number>;
  readonly allGatesPassed: number;
  readonly criticalGatesFailed: number;
};

/**
 * Project entity for the dashboard.
 */
type Project = {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly status: 'active' | 'archived' | 'draft';
  readonly health: ProjectHealth;
  readonly specGroupCount: number;
  readonly specGroupSummary: SpecGroupSummary;
  readonly createdAt: string;
  readonly updatedAt: string;
};

/**
 * Response for listing projects.
 */
type ListProjectsResponse = {
  readonly projects: readonly Project[];
  readonly total: number;
};

const getApiUrl = (): string =>
  process.env.NEXT_PUBLIC_API_URL ?? DEFAULT_API_URL;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const extractErrorMessage = (payload: unknown): string | null => {
  if (typeof payload === 'string') {
    return payload;
  }

  if (isRecord(payload)) {
    const errorValue = payload.error;
    if (typeof errorValue === 'string') {
      return errorValue;
    }

    const messageValue = payload.message;
    if (typeof messageValue === 'string') {
      return messageValue;
    }
  }

  return null;
};

const tryReadJsonError = async (response: Response): Promise<string | null> => {
  try {
    const data = (await response.clone().json()) as unknown;
    return extractErrorMessage(data);
  } catch {
    return null;
  }
};

const buildErrorMessage = async (response: Response): Promise<string> => {
  const jsonError = await tryReadJsonError(response);

  if (jsonError) {
    return jsonError;
  }

  try {
    const text = await response.text();
    if (text) {
      return text;
    }
  } catch {
    // Ignore text read errors
  }

  return 'Unable to complete request.';
};

/**
 * Fetch all projects (AC1.1, AC1.2, AC1.3)
 *
 * Returns projects with:
 * - Name and status (AC1.1)
 * - Spec group count (AC1.2)
 * - Health indicator (AC1.3)
 */
export const fetchProjects = async (): Promise<ListProjectsResponse> => {
  const response = await fetch(`${getApiUrl()}/api/projects`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
    credentials: 'include',
  });

  if (!response.ok) {
    throw new Error(await buildErrorMessage(response));
  }

  const data = (await response.json()) as ListProjectsResponse;
  return data;
};

/**
 * Fetch a single project by ID
 */
export const fetchProject = async (id: string): Promise<Project> => {
  const response = await fetch(
    `${getApiUrl()}/api/projects/${encodeURIComponent(id)}`,
    {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
      credentials: 'include',
    },
  );

  if (!response.ok) {
    throw new Error(await buildErrorMessage(response));
  }

  const data = (await response.json()) as Project;
  return data;
};

export type { ListProjectsResponse, Project, ProjectHealth, SpecGroupSummary };
