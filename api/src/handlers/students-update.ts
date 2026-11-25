// Handler Lambda `students-update` (L3). Identite tiree du jeton; aucun corps journalise.
import { StudentUpdateRequestSchema } from '../../../shared/contract/generated/schemas.js';
import { updateStudent } from '../family/students.js';
import { authOf, json, parseBody, pathId, requireParent, wrap } from '../lib/http.js';
import { familyDeps } from './runtime.js';

export const handler = wrap('students-update', async (e) => json(200, await updateStudent(familyDeps(), requireParent(authOf(e)), pathId(e, 'sid'), parseBody(e, StudentUpdateRequestSchema))));
