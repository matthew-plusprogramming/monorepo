import z from 'zod';

import {
  AnalyticsStackOutputSchema,
  ApiStackOutputSchema,
} from './consumer/output';
import { AnalyticsStack } from './stacks/analytics-stack';
import { ApiLambdaStack } from './stacks/api-lambda-stack';
import { ApiStack, type ApiStackProps } from './stacks/api-stack';
import { BootstrapStack, type BootstrapStackProps } from './stacks/bootstrap';
import {
  ANALYTICS_STACK_NAME,
  API_LAMBDA_STACK_NAME,
  API_STACK_NAME,
  BOOTSTRAP_STACK_NAME,
} from './stacks/names';
import type { Stack, UniversalStackProps } from './types/stack';

export const stacks = [
  {
    name: BOOTSTRAP_STACK_NAME,
    description: 'Bootstrap stack for CdkTF projects',
    Stack: BootstrapStack,
    props: {
      migrateStateToBootstrappedBackend: true,
    },
    outputSchema: z.object(),
  } as const satisfies Stack<BootstrapStackProps>,
  {
    name: API_STACK_NAME,
    description: 'API stack for the application',
    Stack: ApiStack,
    props: {},
    outputSchema: ApiStackOutputSchema,
    stages: ['dev', 'prod'],
  } as const satisfies Stack<ApiStackProps>,
  {
    name: API_LAMBDA_STACK_NAME,
    description: 'Lambdas for API stack',
    Stack: ApiLambdaStack,
    props: {},
    outputSchema: z.object(),
    stages: ['dev', 'prod'],
  },
  {
    name: ANALYTICS_STACK_NAME,
    description: 'Analytics pipeline for DAU/MAU tracking',
    Stack: AnalyticsStack,
    props: {},
    outputSchema: AnalyticsStackOutputSchema,
    stages: ['dev', 'prod'],
  },
] as const satisfies Stack<UniversalStackProps>[];
