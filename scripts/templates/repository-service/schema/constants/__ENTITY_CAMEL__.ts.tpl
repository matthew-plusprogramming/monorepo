export const __ENTITY_CONSTANT___SCHEMA_CONSTANTS = {
  key: {
    /**
     * TODO: update the primary key attribute name to match the DynamoDB schema.
     */
    id: 'id',
  },
  gsi: {
    /**
     * TODO: add global secondary index names or remove this block if not required.
     */
  },
  projection: {
    /**
     * TODO: update the projection expression for the public view of the entity.
     */
    __ENTITY_CAMEL__Public: 'id',
  },
} as const;
