Scripts that may help during development:

Build and deploy lambda (node-server)

```
npm -w node-server run decrypt-envs
npm -w node-server run build
npm -w @cdk/backend-server-cdk run copy-assets-for-cdk
npm -w @cdk/backend-server-cdk run cdk:deploy:dev myapp-api-lambda-stack
npm -w node-server run encrypt-envs
```

Get outputs for myapp-api-stack after clean

```
npm run build
npm -w @cdk/backend-server-cdk run cdk:output:dev myapp-api-stack
```

Full clean and test

```
npm run clean
npm i
npm run build
npm -w @cdk/backend-server-cdk run cdk:output:dev myapp-api-stack
npm -w @cdk/backend-server-cdk run cdk:output:dev myapp-analytics-stack
npm -w node-server run decrypt-envs
npm -w node-server run build
npm -w @cdk/backend-server-cdk run copy-assets-for-cdk
npm -w @cdk/backend-server-cdk run cdk:deploy:dev myapp-api-lambda-stack
npm -w node-server run encrypt-envs
npm run test
```

Scaffold a repository service workflow skeleton

```
node scripts/create-repository-service.mjs <entity-slug>
# Optional flags:
#   --dry-run  Preview generated files without writing
#   --force    Overwrite existing files created in a previous run
```
