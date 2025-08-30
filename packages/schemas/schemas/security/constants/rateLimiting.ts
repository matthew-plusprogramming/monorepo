export const RATE_LIMITING_SCHEMA_CONSTANTS = {
  key: {
    base: 'pk',
    suffix: {
      ip: 'ip',
      userId: 'user-id',
    },
  },
} as const;
