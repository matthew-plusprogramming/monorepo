/**
 * Host-discovery snippet resolution for runtime connectivity templates.
 *
 * `runtime_env.prefer_ipv6` (default `false`) flips the substituted
 * `{{HOST_DISCOVERY}}` snippet from an IPv4-first variant to an IPv6-first
 * variant. Both branches share the exclusion list (link-local, docker-bridge,
 * WSL2, Tailscale, VPN) and stable-sort-by-interface-name ordering per
 * REQ-NFR-013; only the address family filter differs.
 *
 * @module e2e-test-writer/host-discovery
 * @contract runtime-connectivity-host-discovery
 * @req REQ-F-008, REQ-NFR-013
 */

/** Interface-name exclusion regex applied to both IPv4 and IPv6 branches. */
const EXCLUDE_PATTERN = '/^(docker0|br-|vEthernet|tailscale0|utun|tun\\d|ppp)/';

/**
 * Error thrown when `prefer_ipv6` is present but not a boolean.
 * Defense-in-depth only — schema validation upstream rejects this too.
 */
export class InvalidPreferIpv6Error extends Error {
  /** @param {unknown} value */
  constructor(value) {
    super(
      `Invalid runtime_env.prefer_ipv6: ${JSON.stringify(value)}. Expected boolean.`,
    );
    this.name = 'InvalidPreferIpv6Error';
    /** @type {unknown} */
    this.value = value;
    /** @type {string} */
    this.code = 'E_INVALID_PREFER_IPV6';
  }
}

/**
 * IPv4-first discovery snippet. Emitted when `prefer_ipv6: false` or absent.
 *
 * Emits an ESM top-level `import` for `node:os` — the `{{HOST_DISCOVERY}}`
 * marker is substituted into `.mjs` templates where CJS `require` would
 * ReferenceError at runtime.
 *
 * @returns {string}
 */
function ipv4Snippet() {
  return `import os from 'node:os';
/** @returns {string} First non-loopback IPv4 address, or '127.0.0.1' fallback. */
function discoverHost() {
  const EXCLUDE = ${EXCLUDE_PATTERN};
  const ifaces = os.networkInterfaces();
  const candidates = Object.keys(ifaces)
    .filter((name) => !EXCLUDE.test(name))
    .sort()
    .flatMap((name) => (ifaces[name] || []).map((addr) => ({ name, ...addr })))
    .filter((entry) => entry.family === 'IPv4' && !entry.internal);
  return candidates[0]?.address || '127.0.0.1';
}`;
}

/**
 * IPv6-first discovery snippet. Emitted when `prefer_ipv6: true`.
 *
 * Emits an ESM top-level `import` for `node:os` — see `ipv4Snippet` note.
 *
 * @returns {string}
 */
function ipv6Snippet() {
  return `import os from 'node:os';
/** @returns {string} First non-loopback IPv6 address, or '::1' fallback. */
function discoverHost() {
  const EXCLUDE = ${EXCLUDE_PATTERN};
  const LINK_LOCAL = /^fe80::/i;
  const ifaces = os.networkInterfaces();
  const candidates = Object.keys(ifaces)
    .filter((name) => !EXCLUDE.test(name))
    .sort()
    .flatMap((name) => (ifaces[name] || []).map((addr) => ({ name, ...addr })))
    .filter((entry) => entry.family === 'IPv6' && !entry.internal && !LINK_LOCAL.test(entry.address));
  return candidates[0]?.address || '::1';
}`;
}

/**
 * Resolve the `{{HOST_DISCOVERY}}` replacement per `prefer_ipv6`.
 *
 * @param {unknown} preferIpv6 - Raw `runtime_env.prefer_ipv6` value.
 * @returns {string} Snippet (function declaration for `discoverHost`).
 * @throws {InvalidPreferIpv6Error} when present but not boolean.
 */
export function resolveHostDiscovery(preferIpv6) {
  if (preferIpv6 === undefined || preferIpv6 === null || preferIpv6 === false) {
    return ipv4Snippet();
  }
  if (preferIpv6 === true) {
    return ipv6Snippet();
  }
  throw new InvalidPreferIpv6Error(preferIpv6);
}
