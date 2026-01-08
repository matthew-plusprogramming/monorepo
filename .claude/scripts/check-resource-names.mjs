import ts from 'typescript';

import {
  formatFinding,
  isTestFile,
  isTsFile,
  listGitTrackedFiles,
  readFile,
} from './utils.mjs';

const TARGET_PROPERTIES = new Set(['TableName', 'EventBusName']);

const args = new Set(process.argv.slice(2));

if (args.has('--help') || args.has('-h')) {
  console.log(`Usage: node .claude/scripts/check-resource-names.mjs

Flags string-literal resource identifiers (e.g., TableName, EventBusName) in production code so callers reuse CDK outputs.

Options
  -h, --help    Show this message
`);
  process.exit(0);
}

const trackedFiles = listGitTrackedFiles().filter(
  (file) =>
    file.startsWith('apps/node-server/src/') &&
    isTsFile(file) &&
    !isTestFile(file),
);

const findings = [];

for (const file of trackedFiles) {
  const content = readFile(file);
  if (!content.includes('TableName') && !content.includes('EventBusName')) {
    continue;
  }

  const source = ts.createSourceFile(
    file,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  const visit = (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
    ) {
      const propName = node.name.text;
      if (!TARGET_PROPERTIES.has(propName)) {
        ts.forEachChild(node, visit);
        return;
      }

      const initializer = node.initializer;
      if (
        ts.isStringLiteralLike(initializer) ||
        (ts.isTemplateExpression(initializer) &&
          initializer.templateSpans.length === 0)
      ) {
        const { line } = source.getLineAndCharacterOfPosition(
          initializer.getStart(),
        );
        findings.push(
          formatFinding(
            file,
            line + 1,
            `${propName} should reference a CDK output export, not a string literal`,
          ),
        );
      }
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(source, visit);
}

if (findings.length > 0) {
  console.error('❌ Found hard-coded AWS resource identifiers:');
  for (const finding of findings) {
    console.error(`  ${finding}`);
  }
  process.exit(1);
}

console.log('✅ Resource identifiers reference shared CDK output exports.');
