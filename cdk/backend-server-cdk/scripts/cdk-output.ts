import { execSync } from 'node:child_process';

const stack = process.argv[2];
if (!stack) {
  console.error('Usage: npm run cdk:output:<stage> <stack-name>');
  process.exit(1);
}

process.env.STACK = stack;

execSync('npm run cdk:output', { stdio: 'inherit', env: process.env });
