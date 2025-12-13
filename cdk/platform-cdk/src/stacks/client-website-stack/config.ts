import { existsSync, readdirSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';

import { packageRootDir } from '../../location';
import type { UniversalStackProps } from '../../types/stack';

export interface ClientWebsiteStackProps extends UniversalStackProps {
  domainName: string;
  hostedZoneId: string;
  alternateDomainNames?: string[];
}

export interface DomainConfig {
  domainNames: string[];
  hostedZoneId: string;
}

export const CLIENT_WEBSITE_ASSETS_ROOT = resolve(
  packageRootDir,
  'dist',
  'client-website',
);

const contentTypeByExtension: Record<string, string> = {
  '.css': 'text/css',
  '.gif': 'image/gif',
  '.html': 'text/html',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.map': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export const toPosixKey = (assetsRoot: string, filePath: string): string =>
  relative(assetsRoot, filePath).split(sep).join('/');

export const inferContentType = (filePath: string): string =>
  contentTypeByExtension[extname(filePath).toLowerCase()] ??
  'application/octet-stream';

export const resolveCacheControl = (objectKey: string): string =>
  objectKey.endsWith('.html')
    ? 'public, max-age=300, must-revalidate'
    : 'public, max-age=31536000, immutable';

export const normalizeDomainConfig = (
  props: ClientWebsiteStackProps,
): DomainConfig => {
  const trimmedDomain = props.domainName.trim();
  if (!trimmedDomain) {
    throw new Error(
      'CLIENT_WEBSITE_DOMAIN_NAME is required to deploy the client website stack.',
    );
  }

  const trimmedHostedZoneId = props.hostedZoneId.trim();
  if (!trimmedHostedZoneId) {
    throw new Error(
      'CLIENT_WEBSITE_HOSTED_ZONE_ID is required to deploy the client website stack.',
    );
  }

  const domainNames = Array.from(
    new Set(
      [trimmedDomain, ...(props.alternateDomainNames ?? [])]
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );

  if (domainNames.length === 0) {
    throw new Error(
      'At least one domain name is required to create the client website stack.',
    );
  }

  return {
    domainNames,
    hostedZoneId: trimmedHostedZoneId,
  };
};

export const loadClientWebsiteAssets = (root: string): string[] => {
  if (!existsSync(root)) {
    throw new Error(
      `Client website assets not found at ${root}. Build/export client-website then run "npm -w @cdk/platform-cdk run copy-assets-for-cdk".`,
    );
  }

  const files: string[] = [];
  const stack = [root];

  while (stack.length) {
    const current = stack.pop();
    if (!current) continue;
    const entries = readdirSync(current, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }

  if (files.length === 0) {
    throw new Error(
      `Client website assets directory is empty at ${root}. Ensure client-website export produced files before deploying.`,
    );
  }

  return files.sort();
};
