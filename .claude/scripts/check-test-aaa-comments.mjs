import ts from 'typescript';

import { listGitTrackedFiles, readFile } from './utils.mjs';

const TEST_FUNCTION_ROOTS = new Set([
  'it',
  'fit',
  'xit',
  'test',
  'ftest',
  'xtest',
]);

const COMMENT_LABELS = ['Arrange', 'Act', 'Assert'];

const isTypeAssertionExpression =
  typeof ts.isTypeAssertionExpression === 'function'
    ? ts.isTypeAssertionExpression
    : () => false;

const files = listGitTrackedFiles().filter((file) => file.endsWith('.test.ts'));

if (files.length === 0) {
  console.log('✅ No `.test.ts` files found to scan.');
  process.exit(0);
}

const findings = [];

const toLine = (sourceFile, position) =>
  sourceFile.getLineAndCharacterOfPosition(position).line + 1;

const getRootIdentifier = (expression) => {
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return getRootIdentifier(expression.expression);
  }
  if (ts.isElementAccessExpression(expression)) {
    return getRootIdentifier(expression.expression);
  }
  if (ts.isCallExpression(expression)) {
    return getRootIdentifier(expression.expression);
  }
  if (
    ts.isNonNullExpression(expression) ||
    ts.isParenthesizedExpression(expression)
  ) {
    return getRootIdentifier(expression.expression);
  }
  if (ts.isAsExpression(expression) || isTypeAssertionExpression(expression)) {
    return getRootIdentifier(expression.expression);
  }
  return undefined;
};

const gatherCommentMatches = (blockText) =>
  COMMENT_LABELS.reduce((acc, label) => {
    const matches = [
      ...blockText.matchAll(new RegExp(`//\\s*${label}\\b`, 'g')),
    ];
    acc[label] = matches;
    return acc;
  }, {});

const analyzeTestCall = ({ file, sourceFile, sourceText, callExpression }) => {
  const callback = callExpression.arguments.find(
    (argument) =>
      ts.isFunctionExpression(argument) || ts.isArrowFunction(argument),
  );

  if (!callback) {
    return;
  }

  if (!callback.body) {
    const line = toLine(sourceFile, callExpression.getStart(sourceFile));
    findings.push({
      file,
      line,
      message:
        'Test callback must use a block body to host Arrange/Act/Assert comments.',
    });
    return;
  }

  if (!ts.isBlock(callback.body)) {
    const line = toLine(sourceFile, callback.body.getStart(sourceFile));
    findings.push({
      file,
      line,
      message:
        'Test callback must use a block body to host Arrange/Act/Assert comments.',
    });
    return;
  }

  const block = callback.body;
  const blockText = sourceText.slice(
    block.getStart(sourceFile),
    block.getEnd(),
  );
  const commentMatches = gatherCommentMatches(blockText);

  for (const label of COMMENT_LABELS) {
    const matches = commentMatches[label];
    if (matches.length !== 1) {
      const matchLines = matches.map((match) =>
        toLine(sourceFile, block.getStart(sourceFile) + match.index),
      );
      const line =
        matches.length > 0
          ? matchLines[0]
          : toLine(sourceFile, block.getStart(sourceFile));
      findings.push({
        file,
        line,
        message:
          matches.length === 0
            ? `Missing "// ${label}" comment inside test body.`
            : `Multiple "// ${label}" comments found on lines ${matchLines.join(
                ', ',
              )}.`,
      });
    }
  }

  const arrange = commentMatches.Arrange[0];
  const act = commentMatches.Act[0];
  const assert = commentMatches.Assert[0];

  if (arrange && act && assert) {
    const arrangePos = block.getStart(sourceFile) + arrange.index;
    const actPos = block.getStart(sourceFile) + act.index;
    const assertPos = block.getStart(sourceFile) + assert.index;
    if (!(arrangePos < actPos && actPos < assertPos)) {
      findings.push({
        file,
        line: toLine(sourceFile, arrangePos),
        message:
          'Expected "// Arrange", "// Act", and "// Assert" comments to appear in that order.',
      });
    }
  }
};

for (const file of files) {
  let sourceText;
  try {
    sourceText = readFile(file);
  } catch (error) {
    console.warn(`⚠️ Unable to read ${file}: ${error.message}`);
    continue;
  }

  const sourceFile = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const root = getRootIdentifier(node.expression);
      if (root && TEST_FUNCTION_ROOTS.has(root)) {
        analyzeTestCall({ file, sourceFile, sourceText, callExpression: node });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
}

if (findings.length === 0) {
  console.log(
    '✅ All `.test.ts` files contain exactly one Arrange/Act/Assert comment set per test.',
  );
  process.exit(0);
}

findings
  .sort((a, b) => {
    const fileCompare = a.file.localeCompare(b.file);
    if (fileCompare !== 0) {
      return fileCompare;
    }
    return a.line - b.line;
  })
  .forEach(({ file, line, message }) => {
    console.error(`${file}:${line} — ${message}`);
  });

process.exit(1);
