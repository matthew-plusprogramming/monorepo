import { PutItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { describe, expect, it, type MockedFunction, vi } from 'vitest';

import {
  type AnalyticsEventDetail,
  AnalyticsProcessor,
} from '../analyticsProcessor';

vi.mock('../clients/cdkOutputs', () => ({
  analyticsDedupeTableName: 'dedupe-table',
  analyticsAggregateTableName: 'aggregate-table',
}));

const FIXED_NOW = new Date('2025-10-30T00:00:00.000Z');
type Command = PutItemCommand | UpdateItemCommand;
type SendFn = (command: Command) => Promise<unknown>;
type SendMock = MockedFunction<SendFn>;

const createSendMock = (): SendMock => vi.fn<SendFn>();

const createProcessor = (send: SendMock): AnalyticsProcessor =>
  new AnalyticsProcessor({ send }, () => FIXED_NOW);

const collectCommands = (send: SendMock): Command[] =>
  send.mock.calls.map(([command]) => command);

const isPutItemCommand = (command: Command): command is PutItemCommand =>
  command instanceof PutItemCommand;

const isUpdateItemCommand = (command: Command): command is UpdateItemCommand =>
  command instanceof UpdateItemCommand;

const ensurePutItemCommand = (
  command: Command,
  label: string,
): PutItemCommand => {
  if (!isPutItemCommand(command)) {
    throw new Error(`Expected PutItemCommand for ${label}`);
  }
  return command;
};

const ensureUpdateItemCommand = (
  command: Command,
  label: string,
): UpdateItemCommand => {
  if (!isUpdateItemCommand(command)) {
    throw new Error(`Expected UpdateItemCommand for ${label}`);
  }
  return command;
};

const assertUniqueCommandSequence = (commands: Command[]): void => {
  if (commands.length !== 4) {
    throw new Error(`Expected 4 commands, received ${commands.length}`);
  }
  const [
    dailyDedupeRaw,
    dailyAggregateRaw,
    monthlyDedupeRaw,
    monthlyAggregateRaw,
  ] = commands as [Command, Command, Command, Command];
  const dailyDedupe = ensurePutItemCommand(dailyDedupeRaw, 'daily dedupe');
  const dailyAggregate = ensureUpdateItemCommand(
    dailyAggregateRaw,
    'daily aggregate',
  );
  const monthlyDedupe = ensurePutItemCommand(
    monthlyDedupeRaw,
    'monthly dedupe',
  );
  const monthlyAggregate = ensureUpdateItemCommand(
    monthlyAggregateRaw,
    'monthly aggregate',
  );
  expect(dailyDedupe.input.Item?.pk?.S).toBe(
    'dedupe#daily#user-123#2025-10-29',
  );
  expect(dailyAggregate.input.Key?.pk?.S).toBe('dau#2025-10-29');
  expect(monthlyDedupe.input.Item?.pk?.S).toBe(
    'dedupe#monthly#user-123#2025-10',
  );
  expect(monthlyAggregate.input.Key?.pk?.S).toBe('mau#2025-10');
};

const assertMonthlyAggregateOnly = (commands: Command[]): void => {
  expect(commands).toHaveLength(3);
  expect(
    commands.some((command) => {
      if (!isUpdateItemCommand(command)) {
        return false;
      }
      return command.input.Key?.pk?.S === 'dau#2025-10-29';
    }),
  ).toBe(false);
  expect(
    commands
      .filter(isUpdateItemCommand)
      .filter((command) => command.input.Key?.pk?.S === 'mau#2025-10'),
  ).toHaveLength(1);
};

describe('AnalyticsProcessor handle', () => {
  it('records daily and monthly uniques when dedupe succeeds', async () => {
    // Arrange
    const send = createSendMock().mockResolvedValue({});
    const processor = createProcessor(send);
    const detail: AnalyticsEventDetail = {
      userId: 'user-123',
      timestamp: '2025-10-29T23:34:14.303Z',
    };

    // Act
    await processor.handle(detail);

    // Assert
    const commands = collectCommands(send);
    assertUniqueCommandSequence(commands);
  });
});

describe('AnalyticsProcessor dedupe collisions', () => {
  it('skips aggregate updates when dedupe already exists for a period', async () => {
    // Arrange
    const send = createSendMock().mockImplementation((command) => {
      if (command instanceof PutItemCommand) {
        const pk = command.input.Item?.pk?.S ?? '';
        if (pk.startsWith('dedupe#daily#')) {
          const error = new Error('condition failed');
          (error as { name: string }).name = 'ConditionalCheckFailedException';
          return Promise.reject(error);
        }
      }

      return Promise.resolve({});
    });
    const processor = createProcessor(send);
    const detail: AnalyticsEventDetail = {
      userId: 'user-456',
      timestamp: '2025-10-29T11:12:13.000Z',
    };

    // Act
    await processor.handle(detail);

    // Assert
    const commands = collectCommands(send);
    assertMonthlyAggregateOnly(commands);
  });
});

describe('AnalyticsProcessor validation', () => {
  it('rejects events without required identifiers', async () => {
    // Arrange
    const send = createSendMock();
    const processor = createProcessor(send);

    // Act
    const act = processor.handle({
      userId: 'user-789',
      timestamp: 'not a timestamp',
    });

    // Assert
    await expect(act).rejects.toThrow('invalid timestamp');
    expect(send).not.toHaveBeenCalled();
  });
});
