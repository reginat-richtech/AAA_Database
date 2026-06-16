// Auth.js mounts its sign-in / callback / sign-out endpoints here.
import { handlers } from '../../../../auth';

export const runtime = 'nodejs';
export const { GET, POST } = handlers;
