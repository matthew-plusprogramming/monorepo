import type { UserToken } from '@packages/schemas/user';

declare global {
  namespace Express {
    interface Request {
      user?: UserToken;
    }
  }
}
