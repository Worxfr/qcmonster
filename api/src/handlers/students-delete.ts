// Handler Lambda `students-delete` (L3). Identite tiree du jeton; aucun corps journalise.
import { deleteStudent } from '../family/students.js';
import { authOf, noContent, pathId, requireParent, wrap } from '../lib/http.js';
import { familyDeps } from './runtime.js';

export const handler = wrap('students-delete', async (e) => {
  await deleteStudent(familyDeps(), requireParent(authOf(e)), pathId(e, 'sid'));
  return noContent();
});
