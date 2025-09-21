import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { monorepoRootDir, packageRootDir, srcDir } from '@/location';

describe('location helpers', () => {
  const moduleDir = dirname(
    fileURLToPath(new URL('../../location.ts', import.meta.url)),
  );
  const expectedPackageRoot = resolve(moduleDir, '..');
  const expectedMonorepoRoot = resolve(expectedPackageRoot, '../..');

  it('exports srcDir pointing to the module directory', () => {
    expect(srcDir).toBe(moduleDir);
  });

  it('exports packageRootDir one level above srcDir', () => {
    expect(packageRootDir).toBe(expectedPackageRoot);
  });

  it('exports monorepoRootDir two levels above packageRootDir', () => {
    expect(monorepoRootDir).toBe(expectedMonorepoRoot);
  });
});
