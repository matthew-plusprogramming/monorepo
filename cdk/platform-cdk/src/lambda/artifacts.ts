import { resolve } from 'node:path';

import { monorepoRootDir, packageRootDir } from '../location';
import {
  ANALYTICS_LAMBDA_STACK_NAME,
  API_LAMBDA_STACK_NAME,
} from '../stacks/names';

export const lambdaArtifactDefinitions = [
  {
    id: 'apiLambda' as const,
    stackName: API_LAMBDA_STACK_NAME,
    description: 'API Lambda bundle',
    sourceDistRelative: 'apps/node-server/dist',
    stagingSubdir: 'lambdas/api',
    zipFileName: 'lambda.zip',
  },
  {
    id: 'analyticsProcessor' as const,
    stackName: ANALYTICS_LAMBDA_STACK_NAME,
    description: 'Analytics processor Lambda bundle',
    sourceDistRelative: 'apps/analytics-lambda/dist',
    stagingSubdir: 'lambdas/analytics',
    zipFileName: 'analytics-processor-lambda.zip',
  },
] as const;

export type LambdaArtifactDefinition =
  (typeof lambdaArtifactDefinitions)[number];
export type LambdaArtifactId = LambdaArtifactDefinition['id'];

const definitionsById = new Map(
  lambdaArtifactDefinitions.map((definition) => [definition.id, definition]),
);
const definitionsByStackName = new Map(
  lambdaArtifactDefinitions.map((definition) => [
    definition.stackName,
    definition,
  ]),
);

export const getLambdaArtifactDefinition = (
  id: LambdaArtifactId,
): LambdaArtifactDefinition => {
  const definition = definitionsById.get(id);
  if (!definition) {
    throw new Error(`Unknown Lambda artifact id: ${id}`);
  }

  return definition;
};

export const getLambdaArtifactDefinitionByStack = (
  stackName: LambdaArtifactDefinition['stackName'],
): LambdaArtifactDefinition | undefined =>
  definitionsByStackName.get(stackName);

export const resolveSourceDistPath = (
  definition: LambdaArtifactDefinition,
): string => resolve(monorepoRootDir, definition.sourceDistRelative);

export const resolveStagingDirectory = (
  definition: LambdaArtifactDefinition,
): string => resolve(packageRootDir, 'dist', definition.stagingSubdir);

export const resolveZipPath = (definition: LambdaArtifactDefinition): string =>
  resolve(resolveStagingDirectory(definition), definition.zipFileName);

export interface ArtifactRequirement {
  id: LambdaArtifactId;
  stackName: string;
  description: string;
  path: string;
}

export const buildArtifactRequirement = (
  definition: LambdaArtifactDefinition,
): ArtifactRequirement => ({
  id: definition.id,
  stackName: definition.stackName,
  description: definition.description,
  path: resolveZipPath(definition),
});

export const listArtifactRequirements = (): ArtifactRequirement[] =>
  lambdaArtifactDefinitions.map((definition) =>
    buildArtifactRequirement(definition),
  );

export const listLambdaArtifactDefinitions = (): LambdaArtifactDefinition[] => [
  ...lambdaArtifactDefinitions,
];
