import type {
  PutItemCommandInput,
  UpdateItemCommandInput,
} from '@aws-sdk/client-dynamodb';
import {
  ConditionalCheckFailedException,
  PutItemCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';

import {
  analyticsAggregateTableName,
  analyticsDedupeTableName,
} from './clients/cdkOutputs';

export interface AnalyticsEventDetail {
  readonly userId: string;
  readonly timestamp: string;
}

export interface DynamoClient {
  send: (command: PutItemCommand | UpdateItemCommand) => Promise<unknown>;
}

const isConditionalCheckFailure = (error: unknown): boolean => {
  if (error instanceof ConditionalCheckFailedException) {
    return true;
  }
  if (typeof error === 'object' && error !== null) {
    return (
      'name' in error &&
      (error as { name?: string }).name === 'ConditionalCheckFailedException'
    );
  }
  return false;
};

const formatDay = (date: Date): string => date.toISOString().slice(0, 10);
const formatMonth = (date: Date): string => date.toISOString().slice(0, 7);

const createDedupeItem = (
  pk: string,
  detail: AnalyticsEventDetail,
  period: 'daily' | 'monthly',
  nowIso: string,
): PutItemCommandInput => ({
  TableName: analyticsDedupeTableName,
  Item: {
    pk: { S: pk },
    userId: { S: detail.userId },
    occurredAt: { S: detail.timestamp },
    period: { S: period },
    createdAt: { S: nowIso },
  },
  ConditionExpression: 'attribute_not_exists(pk)',
});

const createAggregateUpdate = (
  pk: string,
  period: 'daily' | 'monthly',
  nowIso: string,
): UpdateItemCommandInput => ({
  TableName: analyticsAggregateTableName,
  Key: {
    pk: { S: pk },
  },
  UpdateExpression:
    'ADD #count :one SET #lastSeenAt = :now, #period = if_not_exists(#period, :period)',
  ExpressionAttributeNames: {
    '#count': 'count',
    '#lastSeenAt': 'lastSeenAt',
    '#period': 'period',
  },
  ExpressionAttributeValues: {
    ':one': { N: '1' },
    ':now': { S: nowIso },
    ':period': { S: period },
  },
});

export class AnalyticsProcessor {
  public constructor(
    private readonly dynamo: DynamoClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async handle(detail: AnalyticsEventDetail): Promise<void> {
    this.ensureValidDetail(detail);
    const timestamp = new Date(detail.timestamp);
    const nowIso = this.now().toISOString();

    const dayKey = formatDay(timestamp);
    const monthKey = formatMonth(timestamp);

    await this.processPeriod({
      detail,
      dedupePk: `dedupe#daily#${detail.userId}#${dayKey}`,
      aggregatePk: `dau#${dayKey}`,
      period: 'daily',
      nowIso,
    });

    await this.processPeriod({
      detail,
      dedupePk: `dedupe#monthly#${detail.userId}#${monthKey}`,
      aggregatePk: `mau#${monthKey}`,
      period: 'monthly',
      nowIso,
    });
  }

  private async processPeriod({
    detail,
    dedupePk,
    aggregatePk,
    period,
    nowIso,
  }: {
    detail: AnalyticsEventDetail;
    dedupePk: string;
    aggregatePk: string;
    period: 'daily' | 'monthly';
    nowIso: string;
  }): Promise<void> {
    const dedupeCommand = new PutItemCommand(
      createDedupeItem(dedupePk, detail, period, nowIso),
    );

    try {
      await this.dynamo.send(dedupeCommand);
      await this.dynamo.send(
        new UpdateItemCommand(
          createAggregateUpdate(aggregatePk, period, nowIso),
        ),
      );
      console.info(
        `[AnalyticsProcessor] recorded ${period} unique`,
        dedupePk,
        aggregatePk,
      );
    } catch (error) {
      if (isConditionalCheckFailure(error)) {
        console.info(
          `[AnalyticsProcessor] ${period} dedupe already recorded`,
          dedupePk,
        );
        return;
      }
      console.error(
        `[AnalyticsProcessor] failed ${period} processing`,
        dedupePk,
        error,
      );
      throw error;
    }
  }

  private ensureValidDetail(detail: AnalyticsEventDetail): void {
    if (!detail?.userId) {
      throw new Error('Analytics event missing userId');
    }

    if (!detail?.timestamp) {
      throw new Error('Analytics event missing timestamp');
    }

    const parsedTimestamp = new Date(detail.timestamp);
    if (Number.isNaN(parsedTimestamp.getTime())) {
      throw new Error('Analytics event has invalid timestamp');
    }
  }
}
