Monorepo Infra:

- [ ] Integrate vitest
- [ ] Docs generation?
  - [ ] Perhaps OpenAPI or smth else?
- [x] Integrate IaC (OpenTofu)
- [ ] CI pipeline of some kind
- [ ] Prettier formatting via config.ts and cli
  - [ ] Part of CI?

Backend:

Auth Package (Integrated into node server)

- [x] Error obfuscation for default routes and unauthenticated routes
  - [x] Customizable to send 500 or 502 to mask 400 level errors
- [ ] Set low concurrency (10)
- [x] Coarse rate limiting
  - [ ] Global config
- [ ] Authenticates user
- [ ] Deny-list check
- [ ] Integrate authzed (spiceDB)
- [ ] Configurable kill switch based on conditions or manual action
  - [ ] Cuts reserved concurrency to 0 or 1 depending on the condition
  - [ ] Triggers an alert to be sent to the administrator

Node Server (Lambda)

- [x] Integrate Effect library
- [x] Integrate zod
- [x] Integrate express
- [x] Integrate db options
  - [x] Dynamo
  - [ ] Mongo
    - [ ] Maybe later?
- [ ] Integration test suite to ensure configuration setup correctly
  - [ ] Test behavior, not implementation. Mock only true boundaries (network, DB, clock, randomness, filesystem, process env).
  - [ ] Prefer small, deterministic units + a few integration tests that exercise real wiring.
  - [ ] Standardize patterns: dependency injection, test data builders, and strict AAA (Arrange-Act-Assert).
- [ ] Integrate graphql (gql.tada)
  - [ ] Maybe later?
- [ ] Redis
  - [ ] Maybe later?

Frontend:

- [ ] Integrate basic react setup w/ zustand, react query
- [ ] Integrate single-spa (why not)

Chores:

- [ ] Setup guide on README
