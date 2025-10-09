import type {
  PutEventsCommandInput,
  PutEventsCommandOutput,
} from '@aws-sdk/client-eventbridge';
import { Context, type Effect } from 'effect';

export type EventBridgeServiceSchema = {
  readonly putEvents: (
    input: PutEventsCommandInput,
  ) => Effect.Effect<PutEventsCommandOutput, Error>;
};

export class EventBridgeService extends Context.Tag('EventBridgeService')<
  EventBridgeService,
  EventBridgeServiceSchema
>() {}
