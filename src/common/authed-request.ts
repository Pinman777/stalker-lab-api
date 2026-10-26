import { Request } from 'express';
import type { UserRow } from '../modules/identity/users.repository';

/** Запрос после TmaAuthGuard: req.user заполнен. */
export interface AuthedRequest extends Request {
  user?: UserRow;
}
