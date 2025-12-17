const NODE_SERVER_REQUEST_DECLARATION = `declare global {
  namespace Express {
    interface Request {
      user?: {
        sub: string;
        role?: string;
        [key: string]: unknown;
      };
    }
  }
}
`;

export const removeUsersFromServerIndex = (content) => {
  let updated = content;
  updated = updated.replace(
    /^\s*import\s+\{\s*getUserRequestHandler\s*\}\s+from\s+['"]@\/handlers\/getUser\.handler['"];?\n/m,
    '',
  );
  updated = updated.replace(
    /^\s*import\s+\{\s*loginRequestHandler\s*\}\s+from\s+['"]@\/handlers\/login\.handler['"];?\n/m,
    '',
  );
  updated = updated.replace(
    /^\s*import\s+\{\s*registerRequestHandler\s*\}\s+from\s+['"]@\/handlers\/register\.handler['"];?\n/m,
    '',
  );
  updated = updated.replace(
    /^\s*app\.post\(\s*['"]\/register['"]\s*,\s*registerRequestHandler\s*\);\s*\n/m,
    '',
  );
  updated = updated.replace(
    /^\s*app\.post\(\s*['"]\/login['"]\s*,\s*loginRequestHandler\s*\);\s*\n/m,
    '',
  );
  updated = updated.replace(
    /^\s*app\.get\(\s*['"]\/user\/:identifier['"]\s*,\s*getUserRequestHandler\s*\);\s*\n/m,
    '',
  );
  updated = updated.replace(/\n{3,}/g, '\n\n');
  return updated;
};

export const stripUserRepoFromAppLayer = (content) => {
  let updated = content;
  updated = updated.replace(
    /^\s*import\s+\{\s*LiveUserRepo\s*\}\s+from\s+['"]@\/services\/userRepo\.service['"];?\n/m,
    '',
  );
  updated = updated.replace(/^\s*const\s+LiveUserRepoProvided\s*=.*\n/m, '');
  updated = updated.replace(
    /^\s*export\s+const\s+AppLayer\s*=\s*Base\.pipe\(Layer\.merge\(LiveUserRepoProvided\)\);\s*\n/m,
    'export const AppLayer = Base;\n',
  );
  updated = updated.replace(/\n{3,}/g, '\n\n');
  return updated;
};

export const stripUsersFromNodeCdkOutputs = (content) => {
  let updated = content;
  updated = updated.replace(
    /^\s*export\s+const\s+usersTableName\s*=\s*apiOutput\.apiUserTableName;\s*\n/m,
    '',
  );
  updated = updated.replace(/\n{3,}/g, '\n\n');
  return updated;
};

export const stripPepperFromNodeEnvironmentSchema = (content) => {
  let updated = content;
  updated = updated.replace(/^\s*PEPPER:\s*.*\n/m, '');
  updated = updated.replace(/\n{3,}/g, '\n\n');
  return updated;
};

export const stripUserHashingFromNodeServerPackage = (content) => {
  const json = JSON.parse(content);
  if (json.dependencies?.['@node-rs/argon2']) {
    delete json.dependencies['@node-rs/argon2'];
  }
  const postbuild = json.scripts?.postbuild;
  if (typeof postbuild === 'string') {
    json.scripts.postbuild = postbuild
      .replace(/^tsx scripts\/bundle-argon-2\s*&&\s*/u, '')
      .replace(/\s*&&\s*tsx scripts\/bundle-argon-2\b/u, '');
  }
  return `${JSON.stringify(json, null, 2)}\n`;
};

export const rewriteNodeServerRequestDeclaration = () => NODE_SERVER_REQUEST_DECLARATION;

export const stripUserSchemaDependencyFromIsAuthenticatedMiddleware = (
  content,
) => {
  let updated = content;
  updated = updated.replace(
    /^\s*import\s+\{\s*UserTokenSchema\s*\}\s+from\s+['"]@packages\/schemas\/user['"];?\n/m,
    '',
  );

  if (!/const\s+UserTokenSchema\s*=/.test(updated)) {
    updated = updated.replace(
      /^\s*import\s+z\s+from\s+['"]zod['"];?\n/m,
      `import z from 'zod';\n\nconst UserTokenSchema = z\n  .object({\n    iss: z.string().optional(),\n    sub: z.string(),\n    aud: z.union([z.string(), z.array(z.string())]).optional(),\n    exp: z.number().optional(),\n    iat: z.number().optional(),\n    jti: z.string().optional(),\n    role: z.string().optional(),\n  })\n  .passthrough();\n`,
    );
  }

  updated = updated.replace(/\n{3,}/g, '\n\n');
  return updated;
};

export const stripUsersFromNodeServerCdkOutputsTest = (content) => {
  let updated = content;
  updated = updated.replace(/^\s*apiUserTableName:\s*string;\s*\n/m, '');
  updated = updated.replace(
    /^\s*apiUserVerificationTableName:\s*string;\s*\n/m,
    '',
  );
  updated = updated.replace(/^\s*apiUserTableName:\s*'[^']*',\s*\n/m, '');
  updated = updated.replace(
    /^\s*apiUserVerificationTableName:\s*'[^']*',\s*\n/m,
    '',
  );
  updated = updated.replace(
    /^\s*expect\(module\.usersTableName\)\.toBe\([^)]*\);\s*\n/gm,
    '',
  );
  updated = updated.replace(/\n{3,}/g, '\n\n');
  return updated;
};

export const stripUsersFromNodeServerCdkOutputsStub = (content) => {
  let updated = content;
  updated = updated.replace(/^\s*usersTableName:\s*'[^']*',\s*\n/m, '');
  updated = updated.replace(/\n{3,}/g, '\n\n');
  return updated;
};

export const stripUserRepoFromNodeServerAppLayerTest = (content) => {
  let updated = content;
  updated = updated.replace(
    /^\s*import\s+type\s+\*\s+as\s+UserRepoModule\s+from\s+['"]@\/services\/userRepo\.service['"];?\n/m,
    '',
  );
  updated = updated.replace(
    /^\s*import\s+type\s+\{\s*UserRepoSchema\s*\}\s+from\s+['"]@\/services\/userRepo\.service['"];?\n/m,
    '',
  );
  updated = updated.replace(
    /^\s*const\s+userRepoModule\s*=\s*vi\.hoisted\([\s\S]*?\);\s*\n/m,
    '',
  );
  updated = updated.replace(
    /\nvi\.mock\('@\/services\/userRepo\.service'[\s\S]*?\}\);\n/m,
    '\n',
  );
  updated = updated.replace(
    /\nconst getUserRepoService[\s\S]*?\n};\n/m,
    '\n',
  );
  updated = updated.replace(
    /^\s*const\s+\{\s*UserRepo\s*\}\s*=\s*await\s+import\('@\/services\/userRepo\.service'\);\s*\n/m,
    '',
  );
  updated = updated.replace(/^\s*const\s+repo\s*=.*\n/m, '');
  updated = updated.replace(
    /return\s+\{\s*dynamo,\s*logger,\s*eventBridge,\s*repo\s*\};/m,
    'return { dynamo, logger, eventBridge };',
  );
  updated = updated.replace(
    /return\s+\{\s*dynamo,\s*logger,\s*repo\s*\};/m,
    'return { dynamo, logger };',
  );
  updated = updated.replace(/^\s*expect\(result\.repo\)\..*\n/m, '');
  updated = updated.replace(
    /it\('provides DynamoDb, Logger, EventBridge, and UserRepo services'/,
    "it('provides DynamoDb, Logger, and EventBridge services'",
  );
  updated = updated.replace(
    /it\('provides DynamoDb, Logger, and UserRepo services'/,
    "it('provides DynamoDb and Logger services'",
  );
  updated = updated.replace(/\n{3,}/g, '\n\n');
  return updated;
};

export const stripUsersFromNodeServerEnvironmentTest = (content) => {
  let updated = content;
  updated = updated.replace(/^\s*PEPPER:\s*'[^']*',\s*\n/m, '');
  updated = updated.replace(
    /^\s*\['PEPPER',\s*'PEPPER is required'\],\s*\n/m,
    '',
  );
  updated = updated.replace(/\n{3,}/g, '\n\n');
  return updated;
};

export const stripUsersFromNodeServerIndexTest = (content) => {
  let updated = content;
  updated = updated.replace(
    /^\s*const\s+registerModule\s*=\s*vi\.hoisted<SingleMockState>\([\s\S]*?\);\s*\n/m,
    '',
  );
  updated = updated.replace(
    /^\s*const\s+getUserModule\s*=\s*vi\.hoisted<SingleMockState>\([\s\S]*?\);\s*\n/m,
    '',
  );
  updated = updated.replace(
    /\nvi\.mock\('@\/handlers\/register\.handler'[\s\S]*?\}\);\n/m,
    '\n',
  );
  updated = updated.replace(
    /\nvi\.mock\('@\/handlers\/getUser\.handler'[\s\S]*?\}\);\n/m,
    '\n',
  );
  updated = updated.replace(
    /\nconst requireRegisterHandler[\s\S]*?\n};\n/m,
    '\n',
  );
  updated = updated.replace(/\nconst requireGetUserHandler[\s\S]*?\n};\n/m, '\n');
  updated = updated.replace(
    /\n\s*expect\(expressApp\.post\)\.toHaveBeenCalledWith\([\s\S]*?\);\n/m,
    '\n',
  );
  updated = updated.replace(
    /\n\s*expect\(expressApp\.get\)\.toHaveBeenCalledWith\([\s\S]*?\);\n/m,
    '\n',
  );
  updated = updated.replace(
    /registerModule\.handler = undefined;\n\s*getUserModule\.handler = undefined;\n/m,
    '',
  );
  updated = updated.replace(/\n{3,}/g, '\n\n');
  return updated;
};

export const stripUsersFromNodeServerLambdaTest = (content) => {
  let updated = content;
  updated = updated.replace(
    /^\s*const\s+registerModule\s*=\s*vi\.hoisted<SingleMockState>\([\s\S]*?\);\s*\n/m,
    '',
  );
  updated = updated.replace(
    /^\s*const\s+getUserModule\s*=\s*vi\.hoisted<SingleMockState>\([\s\S]*?\);\s*\n/m,
    '',
  );
  updated = updated.replace(
    /\nvi\.mock\('@\/handlers\/register\.handler'[\s\S]*?\}\);\n/m,
    '\n',
  );
  updated = updated.replace(
    /\nvi\.mock\('@\/handlers\/getUser\.handler'[\s\S]*?\}\);\n/m,
    '\n',
  );
  updated = updated.replace(
    /\nconst requireRegisterHandler[\s\S]*?\n};\n/m,
    '\n',
  );
  updated = updated.replace(/\nconst requireGetUserHandler[\s\S]*?\n};\n/m, '\n');
  updated = updated.replace(
    /\n\s*expect\(expressApp\.post\)\.toHaveBeenCalledWith\([\s\S]*?\);\n/m,
    '\n',
  );
  updated = updated.replace(
    /\n\s*expect\(expressApp\.get\)\.toHaveBeenCalledWith\([\s\S]*?\);\n/m,
    '\n',
  );
  updated = updated.replace(/\n{3,}/g, '\n\n');
  return updated;
};

export const stripUserTablesFromApiStackIndex = (content) => {
  let updated = content;
  updated = updated.replace(
    /^\s*import\s+\{\s*generateUserAndVerificationTable\s*\}\s+from\s+['"]\.\/generate-user-and-verification-table['"];?\n/m,
    '',
  );
  updated = updated.replace(
    /^\s*generateUserAndVerificationTable\(this,\s*region\);\s*\n/m,
    '',
  );
  updated = updated.replace(/\n{3,}/g, '\n\n');
  return updated;
};

export const stripUserTablesFromApiStackConstants = (content) => {
  let updated = content;
  updated = updated.replace(/^\s*export\s+const\s+USER_TABLE_NAME\s*=.*\n/m, '');
  updated = updated.replace(
    /^\s*export\s+const\s+USER_VERIFICATION_TABLE_NAME\s*=.*\n/m,
    '',
  );
  updated = updated.replace(/\n{3,}/g, '\n\n');
  return updated;
};

export const stripUserTablesFromApiStackOutputSchema = (content) => {
  let updated = content;
  updated = updated.replace(/^\s*apiUserTableName:\s*z\.string\(\),\s*\n/m, '');
  updated = updated.replace(
    /^\s*apiUserVerificationTableName:\s*z\.string\(\),\s*\n/m,
    '',
  );
  updated = updated.replace(/\n{3,}/g, '\n\n');
  return updated;
};

export const stripUserExportFromSchemasPackage = (content) => {
  const json = JSON.parse(content);
  if (json.exports?.['./user']) {
    delete json.exports['./user'];
  }
  return `${JSON.stringify(json, null, 2)}\n`;
};

export const stripUsersFromNodeServerReadme = (content) => {
  const filtered = content
    .split('\n')
    .filter(
      (line) =>
        !/POST\s+\/register/i.test(line) &&
        !/POST\s+\/login/i.test(line) &&
        !/GET\s+\/user\//i.test(line) &&
        !/\bPEPPER\b/.test(line) &&
        !/argon2/i.test(line),
    );
  return `${filtered.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
};

export const stripUsersFromRootReadme = (content) => {
  let updated = content;
  updated = updated.replace(
    /Zod schemas for user\/security domains and constants \(keys, GSIs\)\./,
    'Zod schemas for security domains and constants (keys, GSIs).',
  );
  return updated;
};

export const stripUsersFromPlatformReadme = (content) => {
  const filtered = content
    .split('\n')
    .map((line) =>
      line.replace(
        /Application DynamoDB tables \(users, verification, rate limit, deny list\)/i,
        'Application DynamoDB tables (rate limit, deny list)',
      ),
    );
  return `${filtered.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
};

const usersAspect = {
  slug: 'users',
  description:
    'Removes user account subsystem (register/login/getUser handlers, DynamoDB user tables, and shared user schema exports).',
  deletePaths: [
    'apps/node-server/src/handlers/getUser.handler.ts',
    'apps/node-server/src/handlers/login.handler.ts',
    'apps/node-server/src/handlers/register.handler.ts',
    'apps/node-server/src/helpers/token.ts',
    'apps/node-server/src/services/userRepo.service.ts',
    'apps/node-server/scripts/bundle-argon-2.ts',
    'apps/node-server/src/__tests__/builders/user.ts',
    'apps/node-server/src/__tests__/fakes/userRepo.ts',
    'apps/node-server/src/__tests__/handlers/getUser.handler.test.ts',
    'apps/node-server/src/__tests__/handlers/login.handler.test.ts',
    'apps/node-server/src/__tests__/handlers/register.handler.test.ts',
    'apps/node-server/src/__tests__/handlers/register/register.test-helpers.ts',
    'apps/node-server/src/__tests__/helpers/token.helper.test.ts',
    'apps/node-server/src/__tests__/services/userRepo.service.test.ts',
    'cdk/platform-cdk/src/stacks/api-stack/generate-user-and-verification-table.ts',
    'packages/core/schemas/schemas/user',
    'packages/core/schemas/dist/user',
  ],
  fileEdits: [
    {
      path: 'apps/node-server/src/index.ts',
      transform: removeUsersFromServerIndex,
    },
    {
      path: 'apps/node-server/src/layers/app.layer.ts',
      transform: stripUserRepoFromAppLayer,
    },
    {
      path: 'apps/node-server/src/clients/cdkOutputs.ts',
      transform: stripUsersFromNodeCdkOutputs,
    },
    {
      path: 'apps/node-server/src/types/environment.ts',
      transform: stripPepperFromNodeEnvironmentSchema,
    },
    {
      path: 'apps/node-server/package.json',
      transform: stripUserHashingFromNodeServerPackage,
    },
    {
      path: 'apps/node-server/src/types/declarations/request.d.ts',
      transform: rewriteNodeServerRequestDeclaration,
    },
    {
      path: 'apps/node-server/src/middleware/isAuthenticated.middleware.ts',
      transform: stripUserSchemaDependencyFromIsAuthenticatedMiddleware,
    },
    {
      path: 'apps/node-server/src/__tests__/clients/cdkOutputs.test.ts',
      transform: stripUsersFromNodeServerCdkOutputsTest,
    },
    {
      path: 'apps/node-server/src/__tests__/stubs/cdkOutputs.ts',
      transform: stripUsersFromNodeServerCdkOutputsStub,
    },
    {
      path: 'apps/node-server/src/__tests__/layers/app.layer.test.ts',
      transform: stripUserRepoFromNodeServerAppLayerTest,
    },
    {
      path: 'apps/node-server/src/__tests__/types/environment.test.ts',
      transform: stripUsersFromNodeServerEnvironmentTest,
    },
    {
      path: 'apps/node-server/src/__tests__/entry/index.test.ts',
      transform: stripUsersFromNodeServerIndexTest,
    },
    {
      path: 'apps/node-server/src/__tests__/entry/lambda.test.ts',
      transform: stripUsersFromNodeServerLambdaTest,
    },
    {
      path: 'cdk/platform-cdk/src/stacks/api-stack/index.ts',
      transform: stripUserTablesFromApiStackIndex,
    },
    {
      path: 'cdk/platform-cdk/src/stacks/api-stack/constants.ts',
      transform: stripUserTablesFromApiStackConstants,
    },
    {
      path: 'cdk/platform-cdk/src/consumer/output/api-stack-output.ts',
      transform: stripUserTablesFromApiStackOutputSchema,
    },
    {
      path: 'packages/core/schemas/package.json',
      transform: stripUserExportFromSchemasPackage,
    },
    {
      path: 'apps/node-server/README.md',
      transform: stripUsersFromNodeServerReadme,
    },
    {
      path: 'README.md',
      transform: stripUsersFromRootReadme,
    },
    {
      path: 'cdk/platform-cdk/README.md',
      transform: stripUsersFromPlatformReadme,
    },
  ],
  notes: [
    'Run `npm install` after ejection to prune dependencies.',
    'If you also want to remove the analytics pipeline, run `npm run eject:analytics` before ejecting users.',
  ],
};

export default usersAspect;
