# client-website

React 19 + Vite single-page app that lives alongside the Express backend. Styling uses Sass modules with generated `.d.ts` definitions so TypeScript can safely import `.module.scss` files.

## Quick Start

- Install dependencies from the repo root: `npm install`
- In one terminal, generate typed Sass definitions (watches for changes):\
  `npm -w client-website run gen:css-types`
- In another terminal, run the dev server:\
  `npm -w client-website run dev`
- Visit [http://localhost:5173](http://localhost:5173)

## Scripts

- `dev`: Starts Vite’s dev server with hot module reload.
- `prebuild`: Type-checks the project via `tsc -b`.
- `build`: Produces a production bundle under `dist/` (requires `prebuild` to succeed).
- `preview`: Serves the latest production build for smoke testing.
- `clean`: Removes `dist/`, `node_modules/`, and `.turbo`.
- `gen:css-types`: Watches `src/**/*.module.scss` and outputs type definitions into `__generated__/`.
- `lint` / `lint:fix` / `lint:no-cache`: Run ESLint using the shared repo config.
- `test`: Placeholder (`TODO: Implement vitest`).

Run any script from the repo root with the workspace flag. Examples:

- `npm -w client-website run dev`
- `npm -w client-website run lint:fix`

## Styling Workflow

- Component styles live in `src/**/*.module.scss`.
- `gen:css-types` must be running while you add or rename class names so the corresponding `.d.ts` files stay in sync.
- Generated files live under `__generated__/` and should be committed; they provide default exports for class name lookups.

## Testing

Vitest wiring is not implemented yet. The `test` script currently exits immediately and should be replaced once UI requirements stabilize.

## Build Output

- Production bundles emit to `apps/client-website/dist/`.
- Assets reference the repo-relative public path, so deploy the contents of `dist/` behind any static host or CDN.
