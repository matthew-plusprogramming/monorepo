import z from 'zod';

import { ApiStackOutputSchema } from './consumer/output';
import { ApiStack, type ApiStackProps } from './stacks/api-stack';
import { BootstrapStack, type BootstrapStackProps } from './stacks/bootstrap';
import type { Stack } from './types/stack';

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
] as const satisfies Stack<any>[];
