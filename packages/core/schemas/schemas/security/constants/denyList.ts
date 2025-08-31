export const DENY_LIST_SCHEMA_CONSTANTS = {
  key: {
    base: 'pk',
    suffix: {
      ip: 'ip',
      userId: 'user-id',
      userToken: 'user-token',
    },
  },
} as const;
