/**
 * Agent Task Repository Service
 *
 * Provides the live implementation of the AgentTaskRepository for Effect DI.
 */

import {
  AgentTaskRepository,
  createAgentTaskRepository,
} from '@packages/backend-core/agent-tasks';
import { Layer } from 'effect';

/**
 * Live implementation of the AgentTaskRepository service.
 */
export const LiveAgentTaskRepo = Layer.succeed(
  AgentTaskRepository,
  createAgentTaskRepository(),
);
