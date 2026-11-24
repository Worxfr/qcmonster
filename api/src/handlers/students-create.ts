// Handler Lambda `students-create` (L3). Identite tiree du jeton; aucun corps journalise.
import { StudentCreateRequestSchema } from '../../../shared/contract/generated/schemas.js';
import { createStudent } from '../family/students.js';
import { authOf, json, parseBody, requireParent, wrap } from '../lib/http.js';
import { familyDeps } from './runtime.js';

export const handler = wrap('students-create', async (e) => json(201, await createStudent(familyDeps(), requireParent(authOf(e)), parseBody(e, StudentCreateRequestSchema))));
