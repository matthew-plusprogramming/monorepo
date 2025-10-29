import '@dotenvx/dotenvx/config';

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { EventBridgeHandler } from 'aws-lambda';

import type { AnalyticsEventDetail } from './analyticsProcessor';
import { AnalyticsProcessor } from './analyticsProcessor';

const dynamoClient = new DynamoDBClient({});
const processor = new AnalyticsProcessor(dynamoClient);

export const handler: EventBridgeHandler<
  'UserAction',
  AnalyticsEventDetail,
  void
> = async (event) => {
  console.info('Received event:', event.detail);
  /*
  Event Detail example:
  {
    userId: '370a3e8b-b948-4170-8ce0-377fecf1267e',
    timestamp: '2025-10-29T23:34:14.303Z',
    env: 'unknown',
    appVersion: 'unknown',
    platform: 'PostmanRuntime/7.49.0'
  }
  */

  try {
    await processor.handle(event.detail);
  } catch (error) {
    console.error('Failed to process analytics event', {
      error,
      userId: event.detail?.userId,
    });
    throw error;
  }
};
