import { BootstrapStack, type BootstrapStackProps } from '@stacks/bootstrap';
import { MyStack, type MyStackProps } from '@stacks/my-stack';
import type { Stack } from '@type/stack';

// eslint-disable @typescript-eslint/no-explicit-any
export const stacks: Stack<any>[] = [
  {
    name: 'bootstrap',
    description: 'Bootstrap stack for CdkTF projects',
    Stack: BootstrapStack,
    props: {},
  } satisfies Stack<BootstrapStackProps>,
  {
    name: 'my-stack',
    description: 'Example stack for demonstration purposes',
    Stack: MyStack,
    props: {
      bucketName: 'my-example-bucket',
    },
  } satisfies Stack<MyStackProps>,
];
