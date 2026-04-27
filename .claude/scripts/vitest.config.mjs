import { defineConfig } from 'vitest/config';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = __dirname;
const COVERAGE_DIR = resolve(__dirname, 'coverage');

export default defineConfig({
  test: {
    root: resolve(__dirname, '__tests__'),
    environment: 'node',
    include: ['**/*.test.{mjs,js}'],
    globals: false,
    // Disable file-level parallelism: workflow enforcement tests share the
    // real .claude/context/session.json via backup/restore in beforeEach/afterEach,
    // which breaks when multiple test files run concurrently.
    fileParallelism: false,
    coverage: {
      // Advisory-first pass: no thresholds, report-only.
      provider: 'v8',
      // Coverage scope = enforcement scripts covered by this advisory config.
      // Absolute paths avoid ambiguity about which directory Vitest treats as
      // the glob root when instrumenting files imported by child processes.
      include: [
        resolve(SCRIPTS_DIR, 'migrate-manifest.mjs'),
        resolve(SCRIPTS_DIR, 'shape-lint-hook.mjs'),
        resolve(SCRIPTS_DIR, 'dispatch-record-hook.mjs'),
        resolve(SCRIPTS_DIR, 'manifest-post-edit-hook.mjs'),
        resolve(SCRIPTS_DIR, 'lib/path-validate.mjs'),
        resolve(SCRIPTS_DIR, 'lib/kill-switch.mjs'),
        resolve(SCRIPTS_DIR, 'lib/registry-schema.mjs'),
      ],
      exclude: [
        '**/*.test.{mjs,js}',
        '**/__tests__/**',
        '**/__fixtures__/**',
      ],
      reporter: ['text', 'json-summary'],
      // Write coverage output next to the vitest config so it sits alongside
      // the scripts it measures (rather than the repo-root default ./coverage).
      reportsDirectory: COVERAGE_DIR,
      // Many of the covered scripts run as subprocesses (spawned by tests via
      // hook-harness / execFileSync). They live inside the vitest `root`
      // ancestor tree, so `allowExternal: true` keeps them instrumented.
      allowExternal: true,
      // Emit reports even when inherited baseline failures remain.
      reportOnFailure: true,
      // Thresholds intentionally omitted — advisory-first pass.
      // Raise in a follow-up once the baseline has stabilized.
    },
  },
});
