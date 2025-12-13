import { STACK_PREFIX } from '../constants';

export const BOOTSTRAP_STACK_NAME = `${STACK_PREFIX}-bootstrap-stack` as const;
export const API_STACK_NAME = `${STACK_PREFIX}-api-stack` as const;
export const API_LAMBDA_STACK_NAME =
  `${STACK_PREFIX}-api-lambda-stack` as const;
export const ANALYTICS_LAMBDA_STACK_NAME =
  `${STACK_PREFIX}-analytics-lambda-stack` as const;
export const ANALYTICS_STACK_NAME = `${STACK_PREFIX}-analytics-stack` as const;
export const CLIENT_WEBSITE_STACK_NAME =
  `${STACK_PREFIX}-client-website-stack` as const;
