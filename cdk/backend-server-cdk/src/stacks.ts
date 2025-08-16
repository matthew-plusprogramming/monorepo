import z from 'zod';

import { MyStackOutputSchema } from './consumer/output';
import { BootstrapStack, type BootstrapStackProps } from './stacks/bootstrap';
import { MyStack, type MyStackProps } from './stacks/my-stack';
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
    name: 'my-stack',
    description: 'Example stack for demonstration purposes',
    Stack: MyStack,
    props: {
      bucketName: 'my-example-bucket',
    },
    outputSchema: MyStackOutputSchema,
  } as const satisfies Stack<MyStackProps>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
] as const satisfies Stack<any>[];
