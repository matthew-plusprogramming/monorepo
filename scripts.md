Scripts that may help during development:

Build and deploy lambda (node-server)

```
npm -w node-server run decrypt-envs
npm -w node-server run build
npm -w @cdk/backend-server-cdk run copy-assets-for-cdk
npm -w @cdk/backend-server-cdk run cdk:deploy:dev api-lambda-stack
npm -w node-server run encrypt-envs
```

Get outputs for api-stack and api-security-stack after clean

```
npm run build
npm -w @cdk/backend-server-cdk run cdk:output:dev api-stack
npm -w @cdk/backend-server-cdk run cdk:output:dev api-security-stack
```

Full clean and test

```
npm run clean
npm i
npm run build
npm -w @cdk/backend-server-cdk run cdk:output:dev api-stack
npm -w @cdk/backend-server-cdk run cdk:output:dev api-security-stack
npm -w @cdk/backend-server-cdk run cdk:output:dev analytics-stack
npm -w node-server run decrypt-envs
npm -w node-server run build
npm -w @cdk/backend-server-cdk run copy-assets-for-cdk
npm -w @cdk/backend-server-cdk run cdk:deploy:dev api-lambda-stack
npm -w node-server run encrypt-envs
npm run test
```
