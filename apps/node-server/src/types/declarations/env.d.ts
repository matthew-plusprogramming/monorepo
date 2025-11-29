import type { Environment } from '@/types/environment';

declare global {
  namespace NodeJS {
    // We are intentionally declaration merging
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface ProcessEnv extends Environment {}
  }
}
