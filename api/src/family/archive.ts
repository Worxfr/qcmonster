// POST /family/export/archive (H1-B, docs/H1-design.md section 6): zip de l'export de la famille DU JETON avec tout l'historique des tests.
// Contenu: `export.json` (meme contenu que GET /family/export) et `tests/<studentId>.jsonl` (un `TestParentDetail` par ligne). Jamais de reponse
// donnee par l'eleve, de choix ni de texte de question dans les passages (liste blanche `toParentDetail`).
import { isTestSk, testIdOfSk, toParentDetail } from '../../../shared/tests-history.js';
import { expired } from '../game/tests.js';
import { LINK_TTL_S, exportKey, type ArchiveStore } from '../lib/archive-store.js';
import type { Deps } from '../lib/deps.js';
import { HttpError, type ParentCtx } from '../lib/http.js';
import { zip } from '../lib/zip.js';
import { exportFamily } from './family.js';

export const MAX_ARCHIVE_TESTS = 50_000;
/** Au plus 3 archives par heure et par famille (design section 5, regle 7): API Gateway ne sait pas limiter par famille. */
export const MAX_ARCHIVES_PER_HOUR = 3;

export interface ArchiveDeps extends Deps {
  archives: ArchiveStore;
  /** Pour les tests; defaut MAX_ARCHIVE_TESTS. */
  maxTests?: number;
}
export interface ExportArchiveView {
  url: string;
  expiresAt: string;
  format: 'zip';
  sizeBytes: number;
  students: number;
  tests: number;
  truncated: boolean;
}

type Line = ReturnType<typeof toParentDetail>;

/**
 * Garde au plus `max` passages en omettant les annees scolaires les plus anciennes (annees entieres, toute la famille).
 * Si l'annee la plus recente depasse seule `max`, on garde ses `max` passages les plus recents.
 */
export function capByYears(perStudent: Map<string, Line[]>, max: number): { kept: Map<string, Line[]>; truncated: boolean } {
  const all = [...perStudent.values()].flat();
  if (all.length <= max) return { kept: perStudent, truncated: false };
  const counts = new Map<string, number>();
  for (const t of all) counts.set(t.schoolYear, (counts.get(t.schoolYear) ?? 0) + 1);
  const years = [...counts.keys()].sort().reverse();
  const keep = new Set<string>();
  let n = 0;
  for (const y of years) {
    if (n + (counts.get(y) as number) > max) break;
    keep.add(y);
    n += counts.get(y) as number;
  }
  const kept = new Map<string, Line[]>();
  if (keep.size === 0) {
    const cut = all.map((t) => t.startedAt + t.testId).sort().reverse()[max - 1]; // cle du plus ancien passage conserve
    for (const [sid, ls] of perStudent) kept.set(sid, ls.filter((t) => t.startedAt + t.testId >= cut));
  } else for (const [sid, ls] of perStudent) kept.set(sid, ls.filter((t) => keep.has(t.schoolYear)));
  return { kept, truncated: true };
}

/**
 * shortcut: l'archive se construit en memoire en une passe (quelques centaines de Ko par annee; au plus 50 000 passages, ~75 Mo avant compression,
 * d'ou une fonction de 1 Go). Si la mesure depasse 20 s, passer en construction asynchrone (design section 6).
 */
export async function createExportArchive(deps: ArchiveDeps, ctx: ParentCtx): Promise<ExportArchiveView> {
  const now = deps.now();
  const recent = (await deps.archives.list(ctx.familyId)).filter((t) => now.getTime() - t < 3_600_000);
  if (recent.length >= MAX_ARCHIVES_PER_HOUR) throw new HttpError(429, 'quota_epuise', "Trop d'archives demandées, réessaie dans une heure");

  const exported = await exportFamily(deps, ctx);
  const perStudent = new Map<string, Line[]>();
  for (const s of exported.students) {
    const items = (await deps.store.query(`STUDENT#${s.studentId}`, 'TEST#')).filter((i) => isTestSk(i.SK) && !expired(i, now.getTime())).sort((a, b) => a.SK.localeCompare(b.SK));
    perStudent.set(s.studentId, items.map((i) => toParentDetail(i, testIdOfSk(i.SK))));
  }
  const { kept, truncated } = capByYears(perStudent, deps.maxTests ?? MAX_ARCHIVE_TESTS);
  const entries = [{ name: 'export.json', data: Buffer.from(JSON.stringify(exported, null, 1), 'utf8') }];
  let tests = 0;
  for (const [sid, ls] of kept) {
    tests += ls.length;
    entries.push({ name: `tests/${sid}.jsonl`, data: Buffer.from(ls.map((l) => JSON.stringify(l)).join('\n') + (ls.length ? '\n' : ''), 'utf8') });
  }
  const body = zip(entries, now);
  const key = exportKey(ctx.familyId, deps.newId());
  await deps.archives.put(key, body);
  const url = await deps.archives.signedUrl(key);
  return { url, expiresAt: new Date(now.getTime() + LINK_TTL_S * 1000).toISOString(), format: 'zip', sizeBytes: body.length, students: exported.students.length, tests, truncated };
}
