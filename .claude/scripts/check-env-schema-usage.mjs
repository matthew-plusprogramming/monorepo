import ts from 'typescript';

import {
  formatFinding,
  isTestFile,
  isTsFile,
  listGitTrackedFiles,
  readFile,
  splitLines,
} from './utils.mjs';

const ENV_SCHEMA_PATH = 'apps/node-server/src/types/environment.ts';
const EXTRA_ALLOWLIST = new Set(['NODE_ENV', 'npm_package_version']);

const args = new Set(process.argv.slice(2));

if (args.has('--help') || args.has('-h')) {
  console.log(`Usage: node .claude/scripts/check-env-schema-usage.mjs

Ensures every process.env access in apps/node-server/src matches the EnvironmentSchema or approved extras.

Options
  -h, --help        Show this message
  --list-allowed    Print schema + extra keys
`);
  if (args.has('--list-allowed')) {
    for (const key of getAllowedKeys()) {
      console.log(`- ${key}`);
    }
  }
  process.exit(0);
}

function getAllowedKeys() {
  const content = readFile(ENV_SCHEMA_PATH);
  const source = ts.createSourceFile(
    ENV_SCHEMA_PATH,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  const keys = new Set(EXTRA_ALLOWLIST);

  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(source) === 'EnvironmentSchema' &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      node.initializer.expression.getText(source) === 'z.object' &&
      node.initializer.arguments.length > 0
    ) {
      const arg = node.initializer.arguments[0];
      if (ts.isObjectLiteralExpression(arg)) {
        for (const prop of arg.properties) {
          if (ts.isPropertyAssignment(prop)) {
            if (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) {
              keys.add(prop.name.text);
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(source, visit);
  return keys;
}

const allowedKeys = getAllowedKeys();

const trackedFiles = listGitTrackedFiles().filter(
  (file) =>
    file.startsWith('apps/node-server/src/') &&
    isTsFile(file) &&
    !isTestFile(file),
);

const findings = [];

const propertyRegex = /process\.env\.([A-Za-z0-9_]+)/g;
const bracketRegex = /process\.env\[['"]([A-Za-z0-9_]+)['"]\]/g;

for (const file of trackedFiles) {
  const content = readFile(file);
  if (!content.includes('process.env')) continue;

  const lines = splitLines(content);
  lines.forEach((line, index) => {
    let match;
    while ((match = propertyRegex.exec(line)) !== null) {
      const key = match[1];
      if (!allowedKeys.has(key)) {
        findings.push(
          formatFinding(
            file,
            index + 1,
            `process.env.${key} is not defined in EnvironmentSchema`,
          ),
        );
      }
    }
    while ((match = bracketRegex.exec(line)) !== null) {
      const key = match[1];
      if (!allowedKeys.has(key)) {
        findings.push(
          formatFinding(
            file,
            index + 1,
            `process.env['${key}'] is not defined in EnvironmentSchema`,
          ),
        );
      }
    }
  });
}

if (findings.length > 0) {
  console.error(
    '❌ Found environment variable usages missing from EnvironmentSchema:',
  );
  for (const finding of findings) {
    console.error(`  ${finding}`);
  }
  process.exit(1);
}

console.log(
  '✅ All process.env usages map to EnvironmentSchema or approved extras.',
);
