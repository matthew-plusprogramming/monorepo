/**
 * Spec Group Repository Service
 *
 * Provides the live implementation of the SpecGroupRepository for Effect DI.
 */

import {
  createSpecGroupRepository,
  SpecGroupRepository,
} from '@packages/backend-core/spec-groups';
import { Layer } from 'effect';

/**
 * Live implementation of the SpecGroupRepository service.
 */
export const LiveSpecGroupRepo = Layer.succeed(
  SpecGroupRepository,
  createSpecGroupRepository(),
);
