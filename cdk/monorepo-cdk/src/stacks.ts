import { BootstrapStack, type BootstrapStackProps } from '@stacks/bootstrap';
import { MyStack, type MyStackProps } from '@stacks/my-stack';
import type { Stack } from '@type/stack';

export const stacks = [
  {
    name: 'bootstrap',
    description: 'Bootstrap stack for CdkTF projects',
    Stack: BootstrapStack,
    props: {
      migrateStateToBootstrappedBackend: true,
    },
  } as const satisfies Stack<BootstrapStackProps>,
  {
    name: 'my-stack',
    description: 'Example stack for demonstration purposes',
    Stack: MyStack,
    props: {
      bucketName: 'my-example-bucket',
    },
  } as const satisfies Stack<MyStackProps>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
] as const satisfies Stack<any>[];
