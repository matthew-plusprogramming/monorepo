import '@dotenvx/dotenvx/config';

import { App } from 'cdktf';

import { stacks } from './stacks';

const region = process.env.AWS_REGION;

if (!region) {
  throw new Error('AWS_REGION environment variable is not set');
}

const app = new App();

stacks.forEach((stack) => {
  const { Stack } = stack;
  new Stack(app, stack.name, {
    region,
    ...stack.props,
  });
});

app.synth();
