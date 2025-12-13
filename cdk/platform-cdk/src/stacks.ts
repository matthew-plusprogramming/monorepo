import z from 'zod';

import {
  AnalyticsLambdaStackOutputSchema,
  AnalyticsStackOutputSchema,
  ApiLambdaStackOutputSchema,
  ApiStackOutputSchema,
  ClientWebsiteStackOutputSchema,
} from './consumer/output';
import {
  buildArtifactRequirement,
  getLambdaArtifactDefinition,
} from './lambda/artifacts';
import { AnalyticsLambdaStack } from './stacks/analytics-lambda-stack';
import { AnalyticsStack } from './stacks/analytics-stack';
import { ApiLambdaStack } from './stacks/api-lambda-stack';
import { ApiStack, type ApiStackProps } from './stacks/api-stack';
import { BootstrapStack, type BootstrapStackProps } from './stacks/bootstrap';
import {
  ClientWebsiteStack,
  type ClientWebsiteStackProps,
} from './stacks/client-website-stack';
import {
  ANALYTICS_LAMBDA_STACK_NAME,
  ANALYTICS_STACK_NAME,
  API_LAMBDA_STACK_NAME,
  API_STACK_NAME,
  BOOTSTRAP_STACK_NAME,
  CLIENT_WEBSITE_STACK_NAME,
} from './stacks/names';
import type { Stack, UniversalStackProps } from './types/stack';

type StackDefinitionEntry =
  | Stack<BootstrapStackProps>
  | Stack<ApiStackProps>
  | Stack<ClientWebsiteStackProps>
  | Stack<UniversalStackProps>;

const clientWebsiteDomainName = process.env.CLIENT_WEBSITE_DOMAIN_NAME ?? '';
const clientWebsiteHostedZoneId =
  process.env.CLIENT_WEBSITE_HOSTED_ZONE_ID ?? '';
const clientWebsiteAlternateDomainNames =
  process.env.CLIENT_WEBSITE_ALTERNATE_DOMAINS?.split(',')
    .map((value) => value.trim())
    .filter(Boolean) ?? [];

const stackDefinitions = [
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
  } as const satisfies Stack<ApiStackProps>,
  {
    name: API_LAMBDA_STACK_NAME,
    description: 'Lambdas for API stack',
    Stack: ApiLambdaStack,
    props: {},
    outputSchema: ApiLambdaStackOutputSchema,
    requiredArtifacts: [
      buildArtifactRequirement(getLambdaArtifactDefinition('apiLambda')),
    ],
  },
  {
    name: ANALYTICS_LAMBDA_STACK_NAME,
    description: 'Analytics processor lambda stack',
    Stack: AnalyticsLambdaStack,
    props: {},
    outputSchema: AnalyticsLambdaStackOutputSchema,
    requiredArtifacts: [
      buildArtifactRequirement(
        getLambdaArtifactDefinition('analyticsProcessor'),
      ),
    ],
  },
  {
    name: ANALYTICS_STACK_NAME,
    description: 'Analytics pipeline for DAU/MAU tracking',
    Stack: AnalyticsStack,
    props: {},
    outputSchema: AnalyticsStackOutputSchema,
  },
  {
    name: CLIENT_WEBSITE_STACK_NAME,
    description: 'Static hosting for the client website',
    Stack: ClientWebsiteStack,
    props: {
      domainName: clientWebsiteDomainName,
      hostedZoneId: clientWebsiteHostedZoneId,
      alternateDomainNames: clientWebsiteAlternateDomainNames,
    },
    outputSchema: ClientWebsiteStackOutputSchema,
  },
] as const satisfies ReadonlyArray<StackDefinitionEntry>;

export type StackDefinition = (typeof stackDefinitions)[number];
export const stacks = stackDefinitions;
