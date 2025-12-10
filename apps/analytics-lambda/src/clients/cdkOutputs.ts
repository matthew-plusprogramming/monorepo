import { ANALYTICS_STACK_NAME, loadCDKOutput } from '@cdk/platform-cdk';

const baseCdkOutputsPath = __BUNDLED__ ? '.' : undefined;

const analyticsOutput = loadCDKOutput<typeof ANALYTICS_STACK_NAME>(
  ANALYTICS_STACK_NAME,
  baseCdkOutputsPath,
);

export const analyticsDedupeTableName =
  analyticsOutput.analyticsEventDedupeTableName;
export const analyticsAggregateTableName =
  analyticsOutput.analyticsMetricsAggregateTableName;
