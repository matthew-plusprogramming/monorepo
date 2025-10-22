import { STACK_PREFIX } from '../../constants';

export const ANALYTICS_EVENT_BUS_NAME = `${STACK_PREFIX}-analytics-dau-mau-bus`;
export const ANALYTICS_EVENT_BRIDGE_DLQ_NAME = `${STACK_PREFIX}-analytics-eventbridge-dlq`;
export const ANALYTICS_DEDUPE_TABLE_NAME = `${STACK_PREFIX}-analytics-dedupe-table`;
export const ANALYTICS_AGGREGATE_TABLE_NAME = `${STACK_PREFIX}-analytics-aggregate-table`;
export const ANALYTICS_EVENT_INGESTION_LOG_GROUP_NAME = `${STACK_PREFIX}-analytics-event-ingestion-log-group`;
export const ANALYTICS_PROCESSOR_LOG_GROUP_NAME = `${STACK_PREFIX}-analytics-processor-log-group`;
