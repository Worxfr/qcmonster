// Cours conserve SANS son texte (`CoursMeta`): structure, sections et liens vers les fiches. Partage par `GET /cours` et l'export famille.
import { MAX_COURS_PAGES, MAX_COURS_SECTIONS, SUBJECTS } from '../../../shared/scans.js';

type Rec = Record<string, unknown>;
type Section = { fromSentenceId: string; subject: (typeof SUBJECTS)[number]; topic?: string; title?: string; folderId?: string; status: 'fiche' | 'ignoree' | 'sans_fiche' | 'supprimee'; docId?: string };
export type CoursMeta = { coursId: string; createdAt: string; pages: number; sections: Section[] };

const str = (x: unknown): string | undefined => (typeof x === 'string' && x ? x : undefined);

/**
 * `head` = element `COURS#<id>`; `existingDocIds` = fiches encore presentes chez l'eleve. Le lien vers une fiche est resolu a la lecture:
 * une section `fiche` dont la fiche n'existe plus devient `supprimee` (sans `docId`). Une section `fiche` sans `docId` (fiche pas encore generee) reste `sans_fiche`.
 * Ne lit jamais les textes (`COURS#<id>#T<nn>`).
 */
export function coursMeta(head: Rec, existingDocIds: ReadonlySet<string>): CoursMeta {
  const raw = Array.isArray(head.sections) ? (head.sections as Rec[]) : [];
  const sections = raw.slice(0, MAX_COURS_SECTIONS).map((s): Section => {
    const docId = str(s.docId);
    let status: Section['status'];
    if (s.ignore === true || s.statut === 'ignoree') status = 'ignoree';
    else if (s.statut === 'fiche' && docId) status = existingDocIds.has(docId) ? 'fiche' : 'supprimee';
    else status = 'sans_fiche';
    const subject = (SUBJECTS as readonly unknown[]).includes(s.subject) ? (s.subject as Section['subject']) : 'autre';
    return {
      fromSentenceId: String(s.fromSentenceId),
      subject,
      ...(str(s.topic) ? { topic: str(s.topic)!.slice(0, 80) } : {}),
      ...(str(s.title) ? { title: str(s.title)!.slice(0, 200) } : {}),
      ...(str(s.folderId) ? { folderId: str(s.folderId) } : {}),
      status,
      ...(status === 'fiche' ? { docId } : {}),
    };
  });
  return { coursId: String(head.SK).slice('COURS#'.length), createdAt: String(head.createdAt ?? ''), pages: Math.min(MAX_COURS_PAGES, Math.max(1, Number(head.pages) || 1)), sections };
}
