/**
 * Project Repository Service (AS-001)
 *
 * Provides the live implementation of the ProjectRepository for Effect DI.
 */

import {
  createProjectRepository,
  ProjectRepository,
} from '@packages/backend-core/projects';
import { Layer } from 'effect';

/**
 * Live implementation of the ProjectRepository service.
 */
export const LiveProjectRepo = Layer.succeed(
  ProjectRepository,
  createProjectRepository(),
);
