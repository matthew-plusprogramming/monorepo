import z from 'zod';

import {
  AnalyticsStackOutputSchema,
  ApiSecurityStackOutputSchema,
  ApiStackOutputSchema,
} from './consumer/output';
import { AnalyticsStack } from './stacks/analytics-stack';
import { ApiLambdaStack } from './stacks/api-lambda-stack';
import { ApiSecurityStack } from './stacks/api-security-stack';
import { ApiStack, type ApiStackProps } from './stacks/api-stack';
import { BootstrapStack, type BootstrapStackProps } from './stacks/bootstrap';
import type { Stack, UniversalStackProps } from './types/stack';

export const stacks = [
  {
    name: 'bootstrap',
    description: 'Bootstrap stack for CdkTF projects',
    Stack: BootstrapStack,
    props: {
      migrateStateToBootstrappedBackend: true,
    },
    outputSchema: z.object(),
  } as const satisfies Stack<BootstrapStackProps>,
  {
    name: 'api-stack',
    description: 'API stack for the application',
    Stack: ApiStack,
    props: {},
    outputSchema: ApiStackOutputSchema,
  } as const satisfies Stack<ApiStackProps>,
  {
    name: 'api-lambda-stack',
    description: 'Lambdas for API stack',
    Stack: ApiLambdaStack,
    props: {},
    outputSchema: z.object(),
  },
  {
    name: 'api-security-stack',
    description: 'Security stack for API',
    Stack: ApiSecurityStack,
    props: {},
    outputSchema: ApiSecurityStackOutputSchema,
  },
  {
    name: 'analytics-stack',
    description: 'Analytics pipeline for DAU/MAU tracking',
    Stack: AnalyticsStack,
    props: {},
    outputSchema: AnalyticsStackOutputSchema,
  },
] as const satisfies Stack<UniversalStackProps>[];
