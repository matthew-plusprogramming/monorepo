# client-website

Next 16 (app router) marketing site that showcases the component system used across the product pages. Uses typed Sass modules with generated type definitions for CSS class safety.

## Quick Start

- Install deps at the repo root: `npm install`
- Run the dev server: `npm -w client-website run dev`
- Generate Sass module types when adding new `.module.scss` files:
  - Watch mode: `npm -w client-website run gen:css-types`

## Scripts

- `dev`: Start Next.js in dev mode.
- `start`: Serve the production build.
- `build`: Run `tsc -b` then `next build`.
- `clean`: Remove `.next`, `node_modules`, and `.turbo`.
- `gen:css-types`: Generate `__generated__` typings for Sass modules (run when creating/updating `.module.scss` files).
- `test`: Run Vitest unit/component tests.
- `lint` / `lint:fix` / `lint:no-cache`: ESLint + Stylelint checks using the shared config.

Run scripts from the repo root with the workspace flag, e.g. `npm -w client-website run lint`.

## Project Notes

- Source lives under `src/app/**` (Next app router). Components use CSS modules with generated typings under `__generated__/`.
- React Compiler is enabled; keep components functionally pure and avoid unsupported patterns.
- No backend dependency for local dev; the site is static/interactive only.
- Environment: standard Next.js env files (`.env.local`, `.env.development`, etc.) if/when secrets are needed; none are required for the current static content.

## Troubleshooting

- Missing CSS module typings: run `npm -w client-website run gen:css-types` and restart dev server.
- Lint failures for styles: rerun `lint:fix` to apply ESLint/Stylelint fixes before committing.
