import { z } from 'zod';

import { __ENTITY_CONSTANT___SCHEMA_CONSTANTS } from './constants/index.js';

export const __ENTITY_PASCAL__IdSchema = z
  .string()
  /**
   * TODO: tighten the identifier constraints (length/format) to match the domain.
   */
  .min(1, '__ENTITY_PASCAL__ id must be defined');

export const __ENTITY_PASCAL__Schema = z.object({
  /**
   * TODO: expand the schema with the full set of entity attributes.
   */
  id: __ENTITY_PASCAL__IdSchema,
});

export type __ENTITY_PASCAL__ = z.infer<typeof __ENTITY_PASCAL__Schema>;

export const __ENTITY_PASCAL__PublicSchema = __ENTITY_PASCAL__Schema.pick({
  /**
   * TODO: include only the attributes safe for public exposure.
   */
  id: true,
});

export type __ENTITY_PASCAL__Public = z.infer<
  typeof __ENTITY_PASCAL__PublicSchema
>;

export const __ENTITY_PASCAL__KeySchema = z.object({
  /**
   * TODO: adjust key shape (range/sort keys, GSIs) to match DynamoDB design.
   */
  id: __ENTITY_PASCAL__IdSchema,
});
