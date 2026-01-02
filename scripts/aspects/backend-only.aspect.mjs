export const stripClientWebsiteFromPlatformStacks = (content) => {
  let updated = content;
  updated = updated.replace(
    /^\s*ClientWebsiteStackOutputSchema,\s*\n/m,
    '',
  );
  updated = updated.replace(
    /^\s*import\s+\{\s*ClientWebsiteStack[\s\S]*?\}\s+from\s+'\.\/stacks\/client-website-stack';\n/m,
    '',
  );
  updated = updated.replace(/^\s*CLIENT_WEBSITE_STACK_NAME,\s*\n/m, '');
  updated = updated.replace(
    /^\s*const clientWebsiteDomainName[\s\S]*?\?\?\s*\[\];\s*\n/m,
    '',
  );
  updated = updated.replace(
    /\n\s*\{\n\s*name:\s*CLIENT_WEBSITE_STACK_NAME[\s\S]*?\n\s*\}\s+as const satisfies Stack<ClientWebsiteStackProps>,?/m,
    '\n',
  );
  updated = updated.replace(/\n{3,}/g, '\n\n');
  return updated;
};

export const stripClientWebsiteStackNameFromPlatformNames = (content) => {
  let updated = content;
  updated = updated.replace(
    /^\s*export\s+const\s+CLIENT_WEBSITE_STACK_NAME\s*=.*\n/m,
    '',
  );
  updated = updated.replace(/\n{3,}/g, '\n\n');
  return updated;
};

export const stripClientWebsiteExportsFromOutputIndex = (content) => {
  let updated = content;
  updated = updated.replace(
    /^\s*export\s+\*\s+from\s+'\.\/client-website-stack-output';\s*\n/m,
    '',
  );
  updated = updated.replace(/\n{3,}/g, '\n\n');
  return updated;
};

export const stripClientWebsiteFromCopyLambdaArtifacts = (content) => {
  let updated = content;
  updated = updated.replace(
    /import\s+\{\s*monorepoRootDir,\s*packageRootDir\s*\}\s+from\s+'\.\.\/src\/location';\n/,
    "import { packageRootDir } from '../src/location';\n",
  );
  updated = updated.replace(
    /interface WebsiteAssetsManifestEntry[\s\S]*?\nconst createZipArchive/m,
    'const createZipArchive',
  );
  updated = updated.replace(
    /^\s*websiteAssetsManifestEntries\.push\(copyClientWebsiteAssets\(\)\);\s*\n/m,
    '',
  );
  updated = updated.replace(
    /websiteAssets:\s*websiteAssetsManifestEntries\.map\([\s\S]*?\}\)\),\n/,
    'websiteAssets: [],\n',
  );
  updated = updated.replace(/\n{3,}/g, '\n\n');
  return updated;
};

export const stripClientWebsiteFromRootReadme = (content) => {
  let updated = content;
  updated = updated.replace(
    /with an Express 5 backend, a Next 16 marketing site, EventBridge\/DynamoDB analytics processing,/,
    'with an Express 5 backend, EventBridge/DynamoDB analytics processing,',
  );
  updated = updated.replace(
    /Lambda packaging, static client site hosting\)\./,
    'Lambda packaging).',
  );
  updated = updated
    .split('\n')
    .filter(
      (line) =>
        !/client-website/i.test(line) && !/client website/i.test(line),
    )
    .join('\n');
  updated = updated.replace(
    /^4\) Prepare artifacts in the CDK pkg:/m,
    '3) Prepare artifacts in the CDK pkg:',
  );
  updated = updated.replace(/\n{3,}/g, '\n\n');
  return `${updated.trimEnd()}\n`;
};

export const stripClientWebsiteFromPlatformReadme = (content) => {
  let updated = content;
  updated = updated.replace(
    /Asset Staging \(Lambdas \+ Client Website\)/,
    'Asset Staging (Lambdas)',
  );
  updated = updated.replace(
    /Client website stack env:[\s\S]*?Routing note:[\s\S]*?\n\n/m,
    '',
  );
  updated = updated
    .split('\n')
    .filter(
      (line) =>
        !/client-website/i.test(line) &&
        !/client website/i.test(line) &&
        !/CLIENT_WEBSITE_/i.test(line),
    )
    .join('\n');
  updated = updated.replace(
    /^3\) Copy \+ zip artifacts here:/m,
    '2) Copy + zip artifacts here:',
  );
  updated = updated.replace(/\n{3,}/g, '\n\n');
  return `${updated.trimEnd()}\n`;
};

export const stripClientWebsiteFromEslintReadme = (content) => {
  let updated = content;
  updated = updated.replace(
    /npm -w client-website run lint/,
    'npm -w node-server run lint',
  );
  return updated;
};

const backendOnlyAspect = {
  slug: 'backend-only',
  description:
    'Removes frontend apps (client-website, admin-portal) and client website infra/docs.',
  deletePaths: [
    'apps/client-website',
    'apps/admin-portal',
    'cdk/platform-cdk/src/stacks/client-website-stack',
    'cdk/platform-cdk/src/consumer/output/client-website-stack-output.ts',
  ],
  fileEdits: [
    {
      path: 'cdk/platform-cdk/src/stacks.ts',
      transform: stripClientWebsiteFromPlatformStacks,
    },
    {
      path: 'cdk/platform-cdk/src/stacks/names.ts',
      transform: stripClientWebsiteStackNameFromPlatformNames,
    },
    {
      path: 'cdk/platform-cdk/src/consumer/output/index.ts',
      transform: stripClientWebsiteExportsFromOutputIndex,
    },
    {
      path: 'cdk/platform-cdk/scripts/copy-lambda-artifacts.ts',
      transform: stripClientWebsiteFromCopyLambdaArtifacts,
    },
    {
      path: 'README.md',
      transform: stripClientWebsiteFromRootReadme,
    },
    {
      path: 'cdk/platform-cdk/README.md',
      transform: stripClientWebsiteFromPlatformReadme,
    },
    {
      path: 'packages/configs/eslint-config/README.md',
      transform: stripClientWebsiteFromEslintReadme,
    },
  ],
  notes: [
    'Run `npm install` after ejection to prune dependencies.',
    'If you also want to remove analytics, run `npm run eject:analytics`.',
  ],
};

export default backendOnlyAspect;
