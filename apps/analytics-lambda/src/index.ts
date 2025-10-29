import '@dotenvx/dotenvx/config';

import type { EventBridgeHandler } from 'aws-lambda';

export const handler: EventBridgeHandler<'UserAction', any, void> = (event) => {
  console.log('Received event:', event.detail);
  // No response needed
};
