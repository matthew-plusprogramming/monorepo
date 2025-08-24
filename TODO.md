Monorepo Infra:

- [ ] Integrate vitest
- [ ] Integrate IaC (OpenTofu)
- [ ] Docs generation?
- [ ] Prettier formatting via config.ts and cli

Backend:

Auth Package (Integrated into node server)

- [ ] Error obfuscation for default routes and unauthenticated routes
  - [ ] Customizable to send 500 or 502 to mask 400 level errors
- [ ] Set low concurrency (10)
- [ ] Coarse rate limiting
- [ ] Authenticates user
- [ ] Deny-list check
- [ ] Integrate authzed (spiceDB)
- [ ] Configurable kill switch based on conditions or manual action
  - [ ] Cuts reserved concurrency to 0 or 1 depending on the condition
  - [ ] Triggers an alert to be sent to the administrator

Node Server (Lambda)

- Only callable from the auth lambda

- [ ] Integrate Effect library
- [ ] Integrate zod
- [ ] Integrate graphql (gql.tada)
- [ ] Integrate express
- [ ] Integrate db options
- [ ] Redis
- [ ] Mongo
- [ ] Integration test suite to ensure configuration setup correctly

Frontend:

- [ ] Integrate basic react setup w/ zustand, react query
- [ ] Integrate single-spa (why not)

Chores:

- [ ] Setup guide on README
