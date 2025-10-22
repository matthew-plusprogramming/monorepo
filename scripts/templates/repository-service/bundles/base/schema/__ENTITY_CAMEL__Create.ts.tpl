import { z } from 'zod';

import {
  __ENTITY_PASCAL__IdSchema,
  __ENTITY_PASCAL__Schema,
} from './__ENTITY_CAMEL__.js';

export const __ENTITY_PASCAL__CreateSchema = __ENTITY_PASCAL__Schema.extend({
  /**
   * TODO: remove server-managed fields (timestamps, generated identifiers) and add required inputs.
   */
  id: __ENTITY_PASCAL__IdSchema,
});

export type __ENTITY_PASCAL__Create = z.infer<
  typeof __ENTITY_PASCAL__CreateSchema
>;
