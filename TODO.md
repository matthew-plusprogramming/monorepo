Monorepo Infra:

- [ ] Docs generation
  - [ ] OpenAPI
- [x] Integrate IaC (OpenTofu)
- [x] Integrate linting into all packages
- [ ] CI pipeline of some kind
- [x] Prettier formatting via config.ts and cli
  - [x] Part of CI?

Backend:

Auth Package (Integrated into node server)

- [x] Error obfuscation for default routes and unauthenticated routes
  - [x] Customizable to send 500 or 502 to mask 400 level errors
- [x] Set low concurrency (10)
- [x] Coarse rate limiting
  - [ ] Global config
- [ ] Other rate limiting types (token bucket)
- [ ] Implement repo services for specific data access
- [x] Authenticates user
- [ ] Deny-list check
- [ ] Integrate authzed (spiceDB)
- [ ] Configurable kill switch based on conditions or manual action
  - [ ] Cuts reserved concurrency to 0 or 1 depending on the condition
  - [ ] Triggers an alert to be sent to the administrator

Analytics Lambda

- [x] Testing
- [ ] Local server (adapter express)

Node Server (Lambda)

- [x] Integrate Effect library
- [x] Integrate zod
- [x] Integrate express
- [x] Integrate db options
  - [x] Dynamo
  - [ ] Mongo
    - [ ] Maybe later?
- [x] Integration test suite to ensure configuration setup correctly
  - [x] Test behavior, not implementation. Mock only true boundaries (network, DB, clock, randomness, filesystem, process env).
  - [x] Prefer small, deterministic units + a few integration tests that exercise real wiring.
  - [x] Standardize patterns: dependency injection, test data builders, and strict AAA (Arrange-Act-Assert).
- [ ] Integrate graphql (gql.tada)
  - [ ] Maybe later?
- [ ] Redis
  - [ ] Maybe later?

Frontend:

- [ ] Integrate basic react setup w/ zustand, react query
- [ ] Scss
  - [ ] Classnames
- [ ] Integrate single-spa (why not)
  - [ ] Maybe later? (too cumbersome for now)
- [ ] React hookform
- [ ] Create a barebones component suite for common usecases
  - [ ] Button
  - [ ] Navbar
  - [ ] Footer
  - [ ] Sidebar
  - [ ] Sidenav
- [ ] Barebones admin dashboard
- [ ] Barebones user-facing application
- [ ] Barebones landing page

Chores:

- [x] Setup guide on README
