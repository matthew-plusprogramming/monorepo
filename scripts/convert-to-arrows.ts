import { globby } from 'globby';
import {
  FunctionDeclaration,
  FunctionExpression,
  Node,
  Project,
  SyntaxKind,
} from 'ts-morph';

type CallableFunction = FunctionDeclaration | FunctionExpression;

const SOURCE_GLOBS = [
  '**/*.ts',
  '**/*.tsx',
  '!**/*.d.ts',
  '!node_modules',
  '!**/node_modules/**',
  '!**/dist/**',
  '!**/build/**',
  '!**/.turbo/**',
  '!**/.next/**',
];

const hasThisParameter = (fn: CallableFunction) =>
  fn.getParameters().some((parameter) => parameter.getName?.() === 'this');

const isFunctionDeclaration = (
  fn: CallableFunction,
): fn is FunctionDeclaration => Node.isFunctionDeclaration(fn);

const hasHoistedReferences = (fn: FunctionDeclaration) => {
  const nameNode = fn.getNameNode();
  if (!nameNode) {
    return false;
  }

  const references = nameNode.findReferencesAsNodes();
  const declarationStart = fn.getStart(false);
  const definitionStart = nameNode.getStart(false);

  return references.some((referenceNode) => {
    if (referenceNode.getSourceFile() !== fn.getSourceFile()) {
      return false;
    }

    const referenceStart = referenceNode.getStart(false);

    // Skip the declaration itself.
    if (referenceStart === definitionStart) {
      return false;
    }

    return referenceStart < declarationStart;
  });
};

const getTypeParameterText = (fn: CallableFunction) => {
  const parameters = fn.getTypeParameters();

  if (parameters.length === 0) {
    return '';
  }

  const inner = parameters.map((parameter) => parameter.getText()).join(', ');
  const isTsxFile = fn.getSourceFile().getFilePath().endsWith('.tsx');
  const trailingComma = isTsxFile ? ',' : '';
  return `<${inner}${trailingComma}>`;
};

const getParametersText = (fn: CallableFunction) =>
  fn.getParameters().map((parameter) => parameter.getText()).join(', ');

const getReturnTypeText = (fn: CallableFunction) => {
  const node = fn.getReturnTypeNode();
  return node ? `: ${node.getText()}` : '';
};

const getArrowExpression = (fn: CallableFunction) => {
  const asyncKeyword = fn.isAsync() ? 'async ' : '';
  const typeParameterText = getTypeParameterText(fn);
  const parametersText = getParametersText(fn);
  const returnTypeText = getReturnTypeText(fn);
  const body = fn.getBody();

  if (!body) {
    throw new Error('Function is missing a body and cannot be converted.');
  }

  const bodyText = body.getText();

  return `${asyncKeyword}${typeParameterText}(${parametersText})${returnTypeText} => ${bodyText}`;
};

const referencesDisallowedTokens = (fn: CallableFunction) => {
  const body = fn.getBody();
  if (!body) {
    return true;
  }

  if (fn.isGenerator()) {
    return true;
  }

  const descendants = body.getDescendants();
  const usesThis = body.getDescendantsOfKind(SyntaxKind.ThisExpression).length > 0;
  const usesSuper = body.getDescendantsOfKind(SyntaxKind.SuperKeyword).length > 0;
  const usesArguments = descendants.some(
    (descendant) => Node.isIdentifier(descendant) && descendant.getText() === 'arguments',
  );
  const usesNewTarget = body
    .getDescendantsOfKind(SyntaxKind.MetaProperty)
    .some((meta) => meta.getText() === 'new.target');

  if (usesThis || usesSuper || usesArguments || usesNewTarget) {
    return true;
  }

  if (isFunctionDeclaration(fn) && fn.getOverloads().length > 0) {
    return true;
  }

  return false;
};

const shouldSkip = (fn: CallableFunction) =>
  referencesDisallowedTokens(fn) ||
  hasThisParameter(fn) ||
  (isFunctionDeclaration(fn) && hasHoistedReferences(fn));

const convertFunctionDeclaration = (fn: FunctionDeclaration) => {
  if (shouldSkip(fn)) {
    return false;
  }

  const name = fn.getName();
  if (!name) {
    return false;
  }

  const arrowExpression = getArrowExpression(fn);
  const declaration = `const ${name} = ${arrowExpression};`;

  if (fn.isDefaultExport()) {
    fn.replaceWithText(`${declaration}\nexport default ${name};`);
    return true;
  }

  const exportPrefix = fn.isExported() ? 'export ' : '';
  fn.replaceWithText(`${exportPrefix}${declaration}`);
  return true;
};

const convertFunctionExpression = (fn: FunctionExpression) => {
  if (shouldSkip(fn)) {
    return false;
  }

  const arrowExpression = getArrowExpression(fn);
  fn.replaceWithText(arrowExpression);
  return true;
};

const main = async () => {
  const files = await globby(SOURCE_GLOBS, {
    absolute: true,
    cwd: process.cwd(),
    gitignore: true,
    followSymbolicLinks: false,
  });

  if (files.length === 0) {
    console.log('No TypeScript sources found for convert-to-arrows codemode.');
    return;
  }

  const project = new Project({
    skipAddingFilesFromTsConfig: true,
  });
  project.addSourceFilesAtPaths(files);

  let converted = 0;

  for (const sourceFile of project.getSourceFiles()) {
    for (const fn of sourceFile.getFunctions()) {
      if (convertFunctionDeclaration(fn)) {
        converted += 1;
      }
    }

    for (const fn of sourceFile.getDescendantsOfKind(SyntaxKind.FunctionExpression)) {
      if (convertFunctionExpression(fn)) {
        converted += 1;
      }
    }
  }

  if (converted > 0) {
    await project.save();
  }

  console.log(`Converted ${converted} function(s) to arrow functions.`);
};

main().catch((error) => {
  console.error('convert-to-arrows codemode failed.');
  console.error(error);
  process.exit(1);
});
