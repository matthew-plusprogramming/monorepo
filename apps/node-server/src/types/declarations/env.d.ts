import type { Environment } from '@/types/environment';

declare global {
  namespace NodeJS {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface ProcessEnv extends Environment {}
  }
}
