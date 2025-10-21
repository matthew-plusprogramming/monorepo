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
    // Arrange
    // moduleDir defined in outer scope

    // Act
    const result = srcDir;

    // Assert
    expect(result).toBe(moduleDir);
  });

  it('exports packageRootDir one level above srcDir', () => {
    // Arrange
    // expectedPackageRoot defined in outer scope

    // Act
    const result = packageRootDir;

    // Assert
    expect(result).toBe(expectedPackageRoot);
  });

  it('exports monorepoRootDir two levels above packageRootDir', () => {
    // Arrange
    // expectedMonorepoRoot defined in outer scope

    // Act
    const result = monorepoRootDir;

    // Assert
    expect(result).toBe(expectedMonorepoRoot);
  });
});
