import type { Prettify } from '@utils/type-utils';
import type { TerraformStack } from 'cdktf';
import type { Construct } from 'constructs';
import type { ZodObject, ZodType } from 'zod';

import type { ArtifactRequirement } from '../lambda/artifacts';

export interface UniversalStackProps {
  region: string;
}

type AnyZodObject = ZodObject<Record<string, ZodType>>;

export interface Stack<
  TProps extends UniversalStackProps,
  TOutputSchema extends AnyZodObject = AnyZodObject,
> {
  name: string;
  description?: string;
  Stack: new (scope: Construct, id: string, props: TProps) => TerraformStack;
  props: Omit<TProps, keyof UniversalStackProps>;
  outputSchema: TOutputSchema;
  stages?: string[];
  requiredArtifacts?: ArtifactRequirement[];
}

export type AnyStack = Prettify<Stack<UniversalStackProps>>;
