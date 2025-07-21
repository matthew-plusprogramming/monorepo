import type { User } from '@schemas/User';

declare global {
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}
