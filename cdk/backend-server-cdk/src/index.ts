import '@dotenvx/dotenvx/config';

import { App } from 'cdktf';

import { stacks } from './stacks';

const region = process.env.AWS_REGION;
const selectedStack = process.env.STACK;

if (!region) {
  throw new Error('AWS_REGION environment variable is not set');
}

const app = new App();

stacks.forEach((stack) => {
  // Only one stack to be processed at a time
  if (selectedStack && selectedStack !== stack.name) {
    return;
  }

  const { Stack } = stack;
  new Stack(app, stack.name, {
    region,
    ...stack.props,
  });
});

app.synth();
