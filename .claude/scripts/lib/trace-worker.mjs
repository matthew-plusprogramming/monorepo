#!/usr/bin/env node

/**
 * Worker Thread for Parallel Module Analysis (AC-7)
 *
 * Receives module configuration via workerData and produces a low-level
 * trace result. Used by generateAllLowLevelTraces when parallelism is
 * enabled (--parallel N, N > 0).
 *
 * workerData shape:
 *   - moduleConfig: { id, name, description?, fileGlobs }
 *   - traceConfig: { version, modules }
 *   - projectRoot: string
 *   - knownExports: Array<[string, { file, line }]> (Map entries for structured clone)
 *   - cachedGitFiles: string[] | null (cached git ls-files result)
 *   - fileContentEntries: Array<[string, string]> | null (cache entries, null if above threshold)
 */

import { parentPort, workerData } from 'node:worker_threads';

// Dynamically import the main module to get generateLowLevelTrace
// We avoid importing at top level to keep the worker lightweight
// until workerData is available.

async function run() {
  const {
    moduleConfig,
    traceConfig,
    projectRoot,
    knownExports: exportEntries,
    cachedGitFiles,
    fileContentEntries,
  } = workerData;

  // Reconstruct the knownExports Map from entries
  const knownExports = new Map(exportEntries);

  // Workers reconstruct caches from workerData; each worker avoids redundant git ls-files/file reads.
  const traceUtils = await import('./trace-utils.mjs');
  const traceGen = await import('../trace-generate.mjs');

  if (cachedGitFiles) {
    traceUtils.primeGitFilesCache(cachedGitFiles);
  }

  if (fileContentEntries) {
    traceGen.primeContentCache(fileContentEntries);
  }

  try {
    const result = traceGen.writeLowLevelTrace(
      moduleConfig,
      traceConfig,
      projectRoot,
      knownExports,
    );

    parentPort.postMessage({ success: true, result });
  } catch (err) {
    parentPort.postMessage({ success: false, error: err.message });
  }
}

run().catch(err => {
  parentPort.postMessage({ success: false, error: err.message });
});
