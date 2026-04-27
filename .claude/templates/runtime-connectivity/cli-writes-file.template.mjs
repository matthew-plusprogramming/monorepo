/**
 * Runtime Connectivity Smoke Test — archetype: cli-writes-file
 *
 * DO NOT edit without a spec amendment. Contract artifact referenced by
 * `.claude/agents/e2e-test-writer.md`. Placeholder grammar + archetype-specific
 * markers are fixed by the runtime-connectivity authoring docs.
 *
 * Canonical placeholders:
 *   SPEC_ID, PORT, HOST_DISCOVERY, TIMEOUT_MS,
 *   LIVENESS_TIER, PROVISIONING_BLOCK
 *
 * Archetype-specific placeholders:
 *   CLI_INVOCATION, EXPECTED_OUTPUT_PATH,
 *   EXPECTED_FILE_CONTENT_ASSERTION
 *
 * Placeholder grammar: comment-prefixed double-curly tokens.
 *
 * CLI archetype note: PORT + HOST_DISCOVERY placeholders are retained in the
 * canonical set for contract uniformity but are unused for purely-local CLI
 * flows. Substitution supplies innocuous stubs; the test body does not
 * reference them.
 *
 * Emitted to: tests/e2e/<SPEC_ID>.runtime-connectivity.spec.mjs
 *
 * @archetype cli-writes-file
 * @contract runtime-connectivity-template
 */

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// {{PROVISIONING_BLOCK}}

/** Spec metadata — substituted from manifest + frontmatter. */
// {{SPEC_ID}}
// {{LIVENESS_TIER}}
// {{TIMEOUT_MS}}
// {{PORT}}

// {{HOST_DISCOVERY}}

describe(`${SPEC_ID} runtime connectivity [cli-writes-file ${LIVENESS_TIER}]`, () => {
  /** @type {string} */
  let workDir;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), `${SPEC_ID}-`));
  });

  afterAll(() => {
    if (workDir && existsSync(workDir)) {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it(
    'primary event flow — CLI produces expected output file',
    () => {
      // {{CLI_INVOCATION}}

      execSync(CLI_INVOCATION, {
        cwd: workDir,
        stdio: 'inherit',
        timeout: TIMEOUT_MS,
      });

      // {{EXPECTED_OUTPUT_PATH}}
      const outputPath = join(workDir, EXPECTED_OUTPUT_PATH);

      expect(existsSync(outputPath)).toBe(true);

      const contents = readFileSync(outputPath, 'utf-8');

      // {{EXPECTED_FILE_CONTENT_ASSERTION}}
      expect(contents.length).toBeGreaterThan(0);
    },
    TIMEOUT_MS,
  );
});
