---
last_reviewed: 2025-10-21
---

# Active Context

Current Focus

- Keep the Memory Bank and default workflow concise, accurate, and aligned with AGENTS.md guidance.
- Maintain high-signal reflection summaries that point to the latest workflows, scripts, and ADRs.

Next Steps

- Track upstream agent-template updates and capture repo-specific deviations through ADRs when policies diverge.
- Periodically prune reflection/log entries to preserve readability without losing key decisions.

Open Decisions

- Define the long-term ADR indexing cadence as the system matures.

Reflection

- XXXX-XX-XX —
  Plan phase:
  Build phase:
  Verify phase:
- 2025-11-08 — Plan phase: Scoped gradient background work to the home page while reusing palette variables.
  Build phase: Implemented layered gradients via page.module.scss, wired the class in page.tsx, and ran npm run phase:check.
- 2025-11-08 — Verify phase: Confirmed gradient-only changes via git-diff helper and npm run agent:finalize; no additional regressions detected.
- 2025-11-08 — Plan phase: Plan navbar addition in page.tsx using CSS modules with palette-derived styling and responsive layout.
- 2025-11-08 — Build phase: Implemented navbar markup/styles in page.tsx and expanded page.module.scss with flex hero, nav, and responsive CTA buttons; ran npm run phase:check.
- 2025-11-08 — Verify phase: Verified navbar-only diff via git-diff helper and npm run agent:finalize; UI snapshot matches spec with responsive wrap.
- 2025-11-08 — Plan phase: Extract navbar markup/styles from page.tsx into a dedicated Navbar component with its own CSS module for reuse.
- 2025-11-08 — Build phase: Extracted navbar markup to a dedicated component/CSS module and updated page.tsx + hero styles; npm run phase:check passed.
- 2025-11-08 — Verify phase: Confirmed Navbar extraction via git-diff helper and npm run agent:finalize; no regressions reported.
- 2025-11-08 — Plan phase: Diagnosed Navbar media queries using CSS vars that don’t work; will swap to Sass breakpoint constants so responsive wrap behaves without touching tokens.
- 2025-11-08 — Build phase: Added Sass breakpoint constant to Navbar styles and replaced var-based media queries; ran npm run phase:check to ensure the fix passes lint + stylelint.
- 2025-11-08 — Verify phase: Captured diff via git-diff helper and confirmed npm run phase:check already exercised lint/stylelint, so responsive change stays scoped to Navbar styles.
- 2025-11-08 — Plan phase: Scoped Navbar SCSS cleanup: consolidate shared button/link styles via mixins, retain layout + responsive behavior, and keep color tokens as the single source.
  Build phase: Refactored Navbar.module.scss with shared mixins/placeholders, button variant helpers, and responsive utilities while keeping the rendered layout stable.
  Verify phase: Captured the git diff with line numbers and reran npm run phase:check to confirm lint/stylelint coverage; manual review kept Navbar layout + responsiveness unchanged.
- 2025-11-10 — Plan phase: Outlined shared Button component for Navbar/Hero with CTA & secondary displays plus flat/raised click styles; default typography matches Navbar while allowing overrides via className.
- 2025-11-10 — Build phase: Implemented reusable Button component with CTA/secondary displays plus flat/3d click styles, wired it into Navbar + Hero CTA, updated SCSS + generated module typings, and added jiti devDependency for eslint TS config loading.
  Verify phase: Ran npm run phase:check (eslint+stylelint+code quality) and captured node agents/scripts/git-diff-with-lines.mjs for verification; UI diff stays scoped to Navbar/Hero buttons.
- 2025-11-10 — Plan phase: Scaffold login page with Hook Form, gradient background, and Button component while deferring real auth wiring.
- 2025-11-10 — Build phase: Implemented Login page Hook Form with themed card styles and satisfied lint/code-quality via npm run phase:check.
- 2025-11-10 — Verify phase: Verified login scaffold via node agents/scripts/git-diff-with-lines.mjs and npm run phase:check to ensure lint/stylelint/code-quality gates.
- 2025-11-10 — Plan phase: Scoped Button typing fix: use href discriminant to narrow anchor vs button, keep styles/behavior intact, no extra variants.
- 2025-11-10 — Build phase: Refined Button union types: anchor path uses AnchorHTMLAttributes, single forwardRef handles both modes, and default type handling stays scoped to buttons.
- 2025-11-10 — Verify phase: Validated Button typing change via npm run agent:finalize (includes lint/stylelint/code-quality) and captured git-diff-with-lines for review.
- 2025-11-10 — Plan phase: Scoped gradient mixin extraction for login + hero backgrounds so palette tweaks stay centralized.
  Build phase: Added fancy-gradient-background mixin in globals.scss and switched login + hero modules to include it.
  Verify phase: Relied on npm run phase:check (user-run) plus git-diff-with-lines.mjs to confirm only gradient refactor changes.
- 2025-11-10 — Plan phase: Centralizing our color-mix usage by defining descriptive CSS custom properties in globals.scss for surfaces, inputs, and buttons, then updating login/page, Button, and Navbar modules to consume those tokens before running npm run phase:check.
- 2025-11-11 — Build phase: Defined derived color custom properties (surface, input, button, nav) inside globals.scss and refactored the login, Button, and Navbar modules to consume the shared tokens so color-mix usage now lives in one place.
- 2025-11-11 — Verify phase: Captured git diff context for the SCSS refactor, ran npm run phase:check/agent:finalize, and both runs failed because stylelint insists on apps/client-website/stylelint.config.mjs even though only stylelint.config.ts exists.
- 2025-11-11 — Plan phase: Relocating the derived color mixes out of globals.scss into component-scoped SCSS modules (new shared form-controls partial for inputs/buttons plus inline Nav variables), ensuring each consumer re-imports the right tokens and globals only holds base palette + mixins.
- 2025-11-11 — Build phase: Refactored derived color mixes into a scoped form-colors partial plus nav-local variables, updated login inputs and Button modules to import those helpers, and trimmed globals.scss back to base palette/mixins.
  Verify phase: Captured git diff context and reran npm run phase:check (successful this time including stylelint) to confirm the localized color tokens behave identically.
- 2025-11-11 — Plan phase: Implement signup page mirroring login patterns: reuse form layout/styles, add name + confirm password fields with react-hook-form validation, and wire CTA/buttons plus support copy with placeholder submit handler.
- 2025-11-18 — Plan phase: Expand user identifiers to cover username by updating schemas, repo service, and infra.
  Build phase: Added username GSI + Dynamo queries, renamed identifier plumbing, and enforced username/email uniqueness with refreshed tests.
  Verify phase: Captured git-diff-with-lines.mjs output and ran npm run phase:check to keep lint/tests green.
- 2025-11-18 — Plan phase: Planned login auth wiring: add React Query provider, zustand userStore for token, login mutation hitting backend with env-driven base URL, update login form to run mutation+store token and expose errors.
- 2025-11-18 — Plan phase: Track failing @packages/schemas + node-server suites after identifier expansion.
  Build phase: Updated GetUser schema test, userRepo username fixtures, handler/entry tests for new username+cors behavior.
  Verify phase: Re-ran npm -w @packages/schemas run test and npm -w node-server run test to confirm all suites pass.
- 2025-11-18 — Plan phase: Scoped test updates so login/register handler suites expect 401/409/500 responses and real error text after disabling obfuscation; limited to node-server handler tests and preserving AAA conventions.
- 2025-11-18 — Build phase: Updated login/register handler test suites to assert the actual 401/409/500 responses and mapper messages, added deterministic string constants, and reran node-server Vitest to keep coverage green.
- 2025-11-18 — Verify phase: Captured git-diff-with-lines context, reran npm -w node-server run test successfully, and agent:finalize is currently blocked by existing memory-drift findings unrelated to this test change.
