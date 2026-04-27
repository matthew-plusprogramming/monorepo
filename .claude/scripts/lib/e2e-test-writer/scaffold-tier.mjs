/**
 * Scaffold-tier resolution for runtime connectivity templates.
 *
 * Maps `runtime_env.liveness` (default `L1`) to the substituted
 * `{{PROVISIONING_BLOCK}}` snippet. Snippets are verbatim copies of the
 * structural-diff blocks in the agent definition and in the parent spec.
 *
 * @module e2e-test-writer/scaffold-tier
 * @contract runtime-connectivity-scaffold-tier
 * @req REQ-F-008, REQ-F-008a
 */

/** Canonical liveness tier enum. Must match the spec schema liveness enum. */
export const LIVENESS_TIERS = Object.freeze(['L1', 'L2', 'L3']);

/**
 * Error thrown when `runtime_env.liveness` is not in the canonical enum.
 * Defense-in-depth only — schema validation upstream rejects this too.
 */
export class InvalidLivenessError extends Error {
  /** @param {unknown} tier */
  constructor(tier) {
    super(
      `Invalid runtime_env.liveness: ${JSON.stringify(tier)}. Valid values: ${LIVENESS_TIERS.join(', ')}.`,
    );
    this.name = 'InvalidLivenessError';
    /** @type {unknown} */
    this.tier = tier;
    /** @type {string} */
    this.code = 'E_INVALID_LIVENESS';
  }
}

/**
 * L1 scaffold — no external provisioning.
 * @param {string} _specId - Unused for L1 but preserved for signature parity.
 * @returns {string}
 */
function scaffoldL1(_specId) {
  return '// no external provisioning required (L1 in-process)';
}

/**
 * L2 scaffold — author-provisioned shell-script hook.
 * @param {string} specId
 * @returns {string}
 */
function scaffoldL2(specId) {
  return `import { execSync } from 'node:child_process';
beforeAll(() => {
  execSync('bash tests/e2e/provisioning/${specId}.sh', { stdio: 'inherit' });
});
afterAll(() => {
  execSync('bash tests/e2e/provisioning/${specId}.sh --teardown', { stdio: 'inherit' });
});`;
}

/**
 * L3 scaffold — testcontainers DockerComposeEnvironment reference.
 * @param {string} specId
 * @returns {string}
 */
function scaffoldL3(specId) {
  return `import { DockerComposeEnvironment } from 'testcontainers';
/** @type {Awaited<ReturnType<InstanceType<typeof DockerComposeEnvironment>['up']>>} */
let env;
beforeAll(async () => {
  env = await new DockerComposeEnvironment('tests/e2e/containers', '${specId}.compose.yml').up();
});
afterAll(async () => {
  await env.down();
});`;
}

/**
 * Resolve the `{{PROVISIONING_BLOCK}}` replacement for a given liveness tier.
 *
 * @param {unknown} tier - Raw `runtime_env.liveness` value (may be undefined/null).
 * @param {string} specId - manifest.id (used for L2/L3 path interpolation).
 * @returns {string} The JavaScript snippet to splice in.
 * @throws {InvalidLivenessError} when `tier` is present but not in {L1,L2,L3}.
 */
export function resolveProvisioningBlock(tier, specId) {
  // Default L1 when absent.
  if (tier === undefined || tier === null) {
    return scaffoldL1(specId);
  }
  if (typeof tier !== 'string' || !LIVENESS_TIERS.includes(tier)) {
    throw new InvalidLivenessError(tier);
  }
  switch (tier) {
    case 'L1':
      return scaffoldL1(specId);
    case 'L2':
      return scaffoldL2(specId);
    case 'L3':
      return scaffoldL3(specId);
    default:
      // Unreachable — enum guarded above.
      throw new InvalidLivenessError(tier);
  }
}
