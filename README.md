# @matthewlin/monorepo

An opinionated monorepo setup with a selection of packages and apps to kickstart
any project

**⚠️ Warning:** This repository is very heavily WIP and is not production ready

## Architecture

Apps:

- `node-server`: An express-based server that can also run as a lambda

Cdk:

- `backend-server-cdk`: A CDK built on cdktf for managing AWS resources

Packages/Core:

- `@packages/backend-core`: Shared backend utilities including an Effect-powered Express request handler generator, standardized HTTP codes, typed error classes, and basic auth constants.
- `@packages/schemas`: Zod-based domain schemas and constants (users, tokens, verifications, security keys/rate limiting) for validation and typing across services.

Packages/Utils:

- `@utils/ts-utils`: Small runtime helpers like existence checks and TTL utilities (timestamp calculation and expiry checks).
- `@utils/type-utils`: Type-only utilities such as `Prettify<T>` to simplify complex inferred types.

Packages/Configs:

- `@configs/eslint-config`: Shareable ESLint flat config with TypeScript, import sorting, unused-import pruning, TSDoc rules, and Prettier integration.
- `@configs/ts-config`: Centralized TypeScript config bases for the monorepo (strict settings, build/transpile presets, incremental builds).
- `@configs/vite-config`: Base Vite config export with sensible build defaults (ES2024 target, esbuild minify, sourcemaps off).

TODO: Provide setup instructions and link to sub READMEs

## 🔑 Memory Bank (for llm agents & contributors)

This repo includes a **memory bank** that summarizes the architecture, conventions, and workflows.

- **Core file:** [`agents/memory-bank.core.md`](./agents/memory-bank.core.md)

LLM agents should read the core file first, it provides a high-level map and links to deeper details.
