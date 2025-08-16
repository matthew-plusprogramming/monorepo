# @cdk/backend-server-cdk

CDK setup for this monorepo with OpenTofu (Terraform fork)

_note: Terraform support may be dropped in the future, this monorepo
aims to follow OpenTofu compatibility (which as of July 2025
includes Terraform compatibility)_

### Prerequisites

- OpenTofu CLI installed and in PATH

### Usage

1. Run `npm run boostrap`
1. Uncomment the contents of `backend.tf`
1. Run `tofu init`
1. Ensure `export TERRAFORM_BINARY_NAME=tofu` if using OpenTofu

TODO:

- Fix the above usage
- Fix the bootstrap stack to use all the right non deprecated stuff
- Fix
