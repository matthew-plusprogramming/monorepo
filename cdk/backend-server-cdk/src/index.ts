import '@dotenvx/dotenvx/config';

import { App } from 'cdktf';

import { stacks } from './stacks';

const region = process.env.AWS_REGION;

const parseCliStackArgs = (): string[] => {
  const args = process.argv.slice(2);
  const firstArg = args[0];

  if (
    firstArg &&
    (firstArg.endsWith('.ts') ||
      firstArg.endsWith('.tsx') ||
      firstArg.endsWith('.js') ||
      firstArg.endsWith('.jsx'))
  ) {
    args.shift();
  }

  return args.filter((arg) => {
    if (!arg.trim()) {
      return false;
    }

    return !arg.startsWith('-');
  });
};

const getStacksFromEnv = (): string[] => {
  const stackEnv = process.env.STACK;
  if (!stackEnv) {
    return [];
  }

  return stackEnv
    .split(',')
    .map((stackName) => stackName.trim())
    .filter(Boolean);
};

const getSelectedStackNames = (): Set<string> | undefined => {
  const selectedStacksFromEnv = getStacksFromEnv();
  if (selectedStacksFromEnv.length > 0) {
    return new Set(selectedStacksFromEnv);
  }

  const stacksFromCli = parseCliStackArgs();
  if (stacksFromCli.length === 0) {
    return undefined;
  }

  return new Set(stacksFromCli);
};

const selectedStackNames = getSelectedStackNames();

if (!region) {
  throw new Error('AWS_REGION environment variable is not set');
}

const app = new App();

stacks.forEach((stack) => {
  // Only one stack to be processed at a time
  if (selectedStackNames && !selectedStackNames.has(stack.name)) {
    return;
  }

  const { Stack } = stack;

  if (stack.name !== 'myapp-bootstrap-stack' && stack?.stages) {
    stack.stages.forEach((stage) => {
      new Stack(app, `${stack.name}-${stage}`, {
        region,
        ...stack.props,
      });
    });
  } else {
    new Stack(app, stack.name, {
      region,
      ...stack.props,
    });
  }
});

app.synth();
