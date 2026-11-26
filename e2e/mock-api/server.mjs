// API factice AVEC ETAT pour les tests de bout en bout en mode mock (aucun AWS).
// Prism (npm run mock) renvoie toujours les memes exemples: il ne permet pas de creer une famille puis d'envoyer des photos.
// Ce serveur suit le contrat shared/contract/openapi.yaml pour les routes utilisees par le front. Il n'ecrit rien sur disque.
// shortcut: un seul utilisateur a la fois (le role est fixe par POST /__test/reset), pas de jeton, pas de pagination (limit/cursor ignores).
import { createServer } from 'node:http';

const PORT = Number(process.env.MOCK_API_PORT ?? 4012);
const BASE = `http://127.0.0.1:${PORT}`;
const T_READ = Number(process.env.MOCK_READ_MS ?? 700); // duree de la lecture
const T_STEP = Number(process.env.MOCK_STEP_MS ?? 500); // duree de chaque etape apres la confirmation

// Texte fabrique, une liste de phrases par page (la page 1 contient une faute de lecture: « chloropastes »).
const PAGES = [
  [
    'La photosynthèse est le processus par lequel les plantes vertes fabriquent leur matière avec la lumière du soleil.',
    'Elle se déroule dans les chloropastes, des organites riches en chlorophylle.',
    "Cette réaction consomme du dioxyde de carbone et de l'eau, et elle produit du dioxygène.",
  ],
  [
    'La Révolution française commence en 1789 avec la prise de la Bastille.',
    "Le 26 août 1789, l'Assemblée adopte la Déclaration des droits de l'homme et du citoyen.",
  ],
  [
    'Le 21 janvier 1793, le roi Louis XVI est condamné et exécuté.',
    "La Terreur dure de 1793 à 1794 sous l'autorité du Comité de salut public.",
  ],
];

let n = 0;
const id = (p) => `${p}${String(++n).padStart(6, '0')}`;
const iso = (t = Date.now()) => new Date(t).toISOString();
const norm = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const words = (s) => s.trim().split(/\s+/).filter(Boolean).length;

let S;
function reset({ role = 'eleve', family = true, student = true, pagesLimit = 20 } = {}) {
  S = { role, family: family ? { familyId: 'fam1' } : null, students: [], jobs: [], docs: [], cours: [], folders: [], xp: 0, readToday: new Set(), questions: new Map(), fail: null, pagesLimit, tests: [], policyOutdated: false, archives: 0 };
  if (family && student) S.students.push({ studentId: 'stu1', pseudo: 'Lila-7k2f', schoolLevel: 'seconde', under15: false, status: 'actif', pageQuota: 20 });
}
reset();

// ---- H1-W: historique des tests (contrat 1.4). Passages fabriques, du plus recent au plus ancien. ----
const H_SUBJ = [['svt', 'La photosynthèse'], ['histoire_geo', 'La Révolution française'], ['maths', 'Les fonctions affines']];
const H_Q = [
  { questionId: 'qcm-01', kind: 'qcm', prompt: 'Que produit la photosynthèse ?', choices: ['Du dioxygène', 'Du dioxyde de carbone', "De l'azote", "De l'eau"], answer: 'Du dioxygène' },
  { questionId: 'qcm-02', kind: 'qcm', prompt: 'En quelle année a lieu la prise de la Bastille ?', choices: ['1789', '1793', '1804', '1815'], answer: '1789' },
  { questionId: 'gap-01', kind: 'gap', prompt: 'La photosynthèse produit du ____.', answer: 'dioxygène' },
];
const schoolYearOf = (d) => { const x = new Date(d); const y = x.getUTCFullYear(); return x.getUTCMonth() >= 8 ? `${y}-${y + 1}` : `${y - 1}-${y}`; };
/** `recent` passages en 2026-2027 puis `old` en 2025-2026; un passage sur 7 est incomplet. */
function seedHistory({ recent = 24, old = 6 } = {}) {
  const out = [];
  const make = (i, at) => {
    const [matiere, titre] = H_SUBJ[i % 3];
    const qs = H_Q.map((q, k) => {
      const ok = (i + k) % 3 !== 0;
      return { questionId: q.questionId, rank: k + 1, kind: q.kind, correct: ok, attempts: ok ? 1 : 2, firstTry: ok, xpGained: ok ? 5 : 0, answeredAt: iso(at + k * 20e3), choice: ok ? q.answer : q.kind === 'qcm' ? q.choices[1] : 'azote', prompt: q.prompt, ...(q.choices ? { choices: q.choices } : {}), correctAnswer: q.answer };
    });
    const answered = i % 7 === 2 ? 2 : 3;
    const given = qs.slice(0, answered);
    const correct = given.filter((q) => q.correct).length;
    return { testId: `01JF5T3ST${String(i).padStart(17, '0')}`, docId: `doc${i % 3}`, titre, matiere, mode: 'mixte', schoolYear: schoolYearOf(at), startedAt: iso(at), endedAt: iso(at + 60e3), total: 3, answered, correct, firstTry: given.filter((q) => q.firstTry).length, scorePct: Math.round((100 * correct) / 3), xpGained: given.reduce((a, q) => a + q.xpGained, 0), status: answered === 3 ? 'complet' : 'incomplet', questions: given };
  };
  for (let i = 0; i < recent; i++) out.push(make(i, Date.parse('2026-11-20T17:00:00Z') - i * 86400e3));
  for (let i = 0; i < old; i++) out.push(make(recent + i, Date.parse('2026-06-10T16:00:00Z') - i * 86400e3));
  S.tests = out;
}
const summary = ({ questions: _q, ...t }) => t;
function testPage(q) {
  const years = [...new Set(S.tests.map((t) => t.schoolYear))];
  let items = S.tests;
  if (q.get('schoolYear')) items = items.filter((t) => t.schoolYear === q.get('schoolYear'));
  const from = Number(q.get('cursor') ? Buffer.from(q.get('cursor'), 'base64url').toString() : 0);
  const limit = Math.min(50, Number(q.get('limit') ?? 20));
  const page = items.slice(from, from + limit).map(summary);
  const more = from + limit < items.length;
  return { items: page, ...(more ? { nextCursor: Buffer.from(String(from + limit)).toString('base64url') } : {}), ...(from === 0 ? { schoolYears: years } : {}) };
}
const parentView = ({ questions, ...t }) => ({ ...t, questions: questions.map(({ choice: _c, prompt: _p, choices: _s, correctAnswer: _a, ...r }) => r) });
function studentProgress() {
  const bySubj = new Map();
  for (const t of S.tests) { const a = bySubj.get(t.matiere) ?? []; a.push(t.scorePct); bySubj.set(t.matiere, a); }
  const avg = (a) => Math.round(a.reduce((x, y) => x + y, 0) / a.length);
  const docs = S.tests.length ? H_SUBJ.map(([matiere, titre], k) => { const mine = S.tests.filter((t) => t.docId === `doc${k}`); return { docId: `doc${k}`, titre, matiere, pages: 2, createdAt: iso(), tests: mine.length, bestScorePct: Math.max(...mine.map((t) => t.scorePct)), lastScorePct: mine[0].scorePct, lastTestAt: mine[0].startedAt }; }) : [];
  const weeks = S.tests.length ? ['2026-W44', '2026-W45', '2026-W46', '2026-W47'].map((week, i) => ({ week, tests: 2 + i, avgScorePct: [40, 60, 80, 95][i], activeDays: 2 + i })) : [];
  return {
    student: S.students[0], progress: progress(), docs, scans: [], weeks,
    subjects: [...bySubj].map(([matiere, a]) => ({ matiere, tests: a.length, avgScorePct: avg(a) })),
    schoolYears: [...new Set(S.tests.map((t) => t.schoolYear))],
    recentTests: S.tests.slice(0, 10).map(summary),
  };
}

const used = () => S.jobs.filter((j) => !j.refunded).reduce((a, j) => a + j.pages, 0);
const progress = () => ({ xp: S.xp, level: S.xp >= 50 ? 1 : 0, streakDays: S.xp > 0 ? 1 : 0, freezes: 1, stage: S.xp >= 50 ? 2 : 1, pagesRemaining: S.pagesLimit - used(), pagesLimit: S.pagesLimit, resetDate: '2099-01-01', badges: [] });

/** Le job avance avec l'heure: lecture -> a_confirmer; apres confirmation: verification -> generation -> termine. */
function advance(j) {
  const now = Date.now();
  if (j.state === 'transcription' && now >= j.readyAt) { j.state = 'a_confirmer'; j.expiresAt = iso(now + 12 * 3600e3); }
  if (['verification', 'generation'].includes(j.state)) {
    const k = Math.floor((now - j.confirmedAt) / T_STEP);
    j.state = k >= 2 ? 'termine' : k === 1 ? 'generation' : 'verification';
    if (j.state === 'termine' && !j.finishedAt) { j.finishedAt = iso(); makeDocs(j); }
  }
  return j;
}
const STAGE = { en_attente_envoi: 'envoi', transcription: 'lecture', a_confirmer: 'a_confirmer', verification: 'verification', generation: 'qcm', termine: 'termine', rejete: 'echec' };
function status(j) {
  const stage = STAGE[j.state];
  const done = stage === 'envoi' ? j.received : stage === 'lecture' ? 0 : j.pages;
  return { stage, pagesDone: done, pagesTotal: j.pages, startedAt: j.createdAt, ...(j.finishedAt ? { finishedAt: j.finishedAt } : {}), ...(j.state === 'a_confirmer' ? { expiresAt: j.expiresAt, expiresSoon: false } : {}), ...(j.message ? { message: j.message } : {}) };
}
const jobOut = (j) => { advance(j); return { jobId: j.jobId, state: j.state, pages: j.pages, createdAt: j.createdAt, status: status(j), ...(j.message ? { message: j.message } : {}), ...(j.docIds ? { docId: j.docIds[0], docIds: j.docIds } : {}) }; };

const textOf = (j) => Array.from({ length: j.pages }, (_, i) => ({ page: i + 1, sentences: PAGES[i % PAGES.length].map((t, k) => ({ id: `p${i + 1}-s${k + 1}`, text: j.fixed?.[`p${i + 1}-s${k + 1}`] ?? t })) }));

function makeDocs(j) {
  const all = textOf(j).flatMap((p) => p.sentences);
  const cours = { coursId: id('crs'), createdAt: j.createdAt, pages: j.pages, texts: textOf(j), sections: [] };
  j.docIds = [];
  const kept = j.sections.filter((s) => !s.ignore).length;
  j.sections.forEach((s, i) => {
    const from = all.findIndex((x) => x.id === s.fromSentenceId);
    const to = i + 1 < j.sections.length ? all.findIndex((x) => x.id === j.sections[i + 1].fromSentenceId) : all.length;
    const sents = all.slice(from, to);
    if (s.ignore) return cours.sections.push({ fromSentenceId: s.fromSentenceId, subject: s.subject, status: 'ignoree' });
    const docId = id('doc');
    const topic = s.topic || 'Sans sujet';
    const src = { passageId: 'src1', url: 'https://fr.wikipedia.org/wiki/Test', site: 'fr.wikipedia.org', titre: 'Page de test', extrait: 'Extrait de test.', niveau: 2 };
    const doc = { docId, jobId: j.jobId, coursId: cours.coursId, title: s.title || topic, subject: s.subject, topic, folderId: s.folderId || j.folderId, createdAt: iso(), sectionIndex: i, sectionCount: kept, summary: sents[0].text, claims: sents.map((x, k) => ({ claimId: String(k + 1).padStart(2, '0'), text: x.text, status: 'verifiee', aRisque: false, sources: [src] })) };
    S.docs.push(doc);
    j.docIds.push(docId);
    S.questions.set(docId, [
      { questionId: `${docId}-q1`, kind: 'qcm', prompt: `De quoi parle la fiche « ${doc.title} » ?`, choices: [topic, 'Les volcans', 'La grammaire', 'Les fractions'], answer: topic },
      { questionId: `${docId}-q2`, kind: 'gap', prompt: 'Complète avec le sujet de la fiche : ____', answer: topic },
    ]);
    cours.sections.push({ fromSentenceId: s.fromSentenceId, subject: s.subject, topic, title: doc.title, status: 'fiche', docId });
  });
  S.cours.push(cours);
}

const scanItem = (j, d) => {
  const base = { scanId: j.jobId, studentId: 'stu1', state: j.state, pages: j.pages, createdAt: j.createdAt, status: status(j) };
  if (!d) return { ...base, ...(j.folderId ? { folderId: j.folderId } : {}) };
  return { ...base, docId: d.docId, title: d.title, subject: d.subject, topic: d.topic, ...(d.folderId ? { folderId: d.folderId } : {}), ...(d.coursId ? { coursId: d.coursId, sectionIndex: d.sectionIndex, sectionCount: d.sectionCount } : {}) };
};
const ORDER = ['envoi', 'lecture', 'a_confirmer', 'fiche', 'verification', 'qcm', 'termine', 'echec'];
function listScans(q) {
  let items = [];
  for (const j of S.jobs) {
    advance(j);
    if (j.state === 'rejete' && /^annul/i.test(j.message ?? '')) continue; // comme l'API: un scan annule n'est pas liste
    if (j.state === 'termine') items.push(...S.docs.filter((d) => d.jobId === j.jobId).map((d) => scanItem(j, d)));
    else items.push(scanItem(j));
  }
  const vis = [...items];
  const stat = q.get('status');
  if (q.get('subject')) items = items.filter((i) => (q.get('subject') === 'none' ? !i.subject : i.subject === q.get('subject')));
  if (q.get('topic')) items = items.filter((i) => i.topic && norm(i.topic) === norm(q.get('topic')));
  const fq = q.get('folderId');
  if (fq && fq !== 'none' && !S.folders.some((f) => f.folderId === fq)) return null; // comme l'API: un dossier inconnu repond 404
  if (q.get('folderId')) items = items.filter((i) => (q.get('folderId') === 'none' ? !i.folderId : i.folderId === q.get('folderId')));
  if (stat) items = items.filter((i) => (stat === 'en_cours' ? !['termine', 'echec'].includes(i.status.stage) : i.status.stage === stat));
  const sort = q.get('sort') ?? 'date';
  const dir = q.get('order') ?? (sort === 'subject' || sort === 'topic' ? 'asc' : 'desc');
  const cmpS = (a, b) => (a ?? '\uffff').localeCompare(b ?? '\uffff', 'fr');
  items.sort((a, b) => {
    let r = 0;
    if (sort === 'subject') r = cmpS(a.subject, b.subject) || cmpS(a.topic, b.topic);
    else if (sort === 'topic') r = cmpS(a.topic, b.topic);
    else if (sort === 'status') r = ORDER.indexOf(a.status.stage) - ORDER.indexOf(b.status.stage);
    else r = a.createdAt.localeCompare(b.createdAt);
    if (dir === 'desc') r = -r;
    return r || b.createdAt.localeCompare(a.createdAt) || (a.sectionIndex ?? 0) - (b.sectionIndex ?? 0);
  });
  const count = (k) => { const m = new Map(); for (const i of vis) if (i[k]) m.set(i[k], (m.get(i[k]) ?? 0) + 1); return [...m].map(([v, c]) => ({ [k]: v, count: c })); };
  return { items, inProgress: vis.filter((i) => !['termine', 'echec'].includes(i.status.stage)).length, toReview: vis.filter((i) => i.status.stage === 'a_confirmer').length, facets: { subjects: count('subject'), topics: count('topic') } };
}

/** Dossiers et fiches deja pretes: `{ folders: ['Maths'], docs: [{ title, subject, topic, folder: 'Maths' }] }`. */
function seed({ folders = [], docs = [] } = {}) {
  for (const name of folders) S.folders.push({ folderId: id('fld'), name, createdAt: iso() });
  for (const x of docs) {
    const jobId = id('job');
    const j = { jobId, pages: 1, createdAt: iso(), state: 'termine', finishedAt: iso(), received: 1, bytes: 0, docIds: [] };
    const docId = id('doc');
    const folderId = x.folder ? S.folders.find((f) => f.name === x.folder)?.folderId : undefined;
    S.jobs.push(j);
    j.docIds.push(docId);
    S.docs.push({ docId, jobId, title: x.title, subject: x.subject ?? 'svt', topic: x.topic ?? x.title, ...(folderId ? { folderId } : {}), createdAt: iso(), summary: 'Résumé de test.', claims: [] });
  }
}

const folderOut = (f) => ({ folderId: f.folderId, name: f.name, createdAt: f.createdAt, scanCount: S.docs.filter((d) => d.folderId === f.folderId).length });
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS' };
function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', ...CORS });
  res.end(status === 204 ? undefined : JSON.stringify(body));
}
const err = (res, status, code, message) => send(res, status, { code, message });
const readBody = (req) => new Promise((ok) => { const c = []; req.on('data', (b) => c.push(b)); req.on('end', () => ok(Buffer.concat(c))); });
const json = (b) => { try { return JSON.parse(b.toString() || '{}'); } catch { return {}; } };

/** Memes regles que POST /jobs/{id}/confirm du contrat (ordre, premiere phrase, 40 mots, au moins une fiche). */
function confirm(j, b) {
  const all = textOf(j).flatMap((p) => p.sentences);
  const fixed = {};
  for (const c of b.corrections ?? []) { if (!all.some((s) => s.id === c.id) || !c.text?.trim()) return [400, 'requete_invalide', 'Demande invalide']; fixed[c.id] = c.text; }
  if ([b.folderId, ...(b.sections ?? []).map((x) => x.folderId)].some((f) => f && !S.folders.some((x) => x.folderId === f))) return [404, 'introuvable', 'Dossier introuvable'];
  const secs = b.sections?.length ? b.sections : [{ fromSentenceId: all[0].id, subject: b.subject ?? 'autre', topic: b.topic ?? 'Sans sujet', folderId: b.folderId }];
  if (secs.length > Math.min(6, 2 * j.pages)) return [400, 'requete_invalide', 'Trop de fiches'];
  let last = -1;
  for (const s of secs) { const p = all.findIndex((x) => x.id === s.fromSentenceId); if (p <= last) return [400, 'requete_invalide', "Les coupes doivent suivre l'ordre du texte"]; last = p; }
  if (secs[0].fromSentenceId !== all[0].id) return [400, 'requete_invalide', 'La première section doit commencer au début du texte'];
  if (secs.every((s) => s.ignore)) return [400, 'requete_invalide', 'Il faut au moins une fiche'];
  for (const s of secs) if (!s.ignore && !(s.topic ?? '').trim()) return [400, 'requete_invalide', 'Demande invalide'];
  let w = 0;
  secs.forEach((s, i) => {
    if (s.ignore) return;
    const from = all.findIndex((x) => x.id === s.fromSentenceId);
    const to = i + 1 < secs.length ? all.findIndex((x) => x.id === secs[i + 1].fromSentenceId) : all.length;
    for (const x of all.slice(from, to)) w += words(fixed[x.id] ?? x.text);
  });
  if (w < 40) return [400, 'requete_invalide', 'Il faut au moins 40 mots dans les parties gardées'];
  Object.assign(j, { fixed, sections: secs, state: 'verification', confirmedAt: Date.now() });
  return null;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, BASE);
  const p = url.pathname;
  const m = req.method;
  if (m === 'OPTIONS') return send(res, 204);
  if (p.startsWith('/__s3/')) { // faux S3: une page par POST
    const body = await readBody(req);
    const j = S.jobs.find((x) => x.jobId === p.split('/')[2]);
    if (S.fail === 's3') return err(res, 500, 'erreur', 'panne');
    if (j) { j.received += 1; j.bytes += body.length; if (j.received >= j.pages) { j.state = 'transcription'; j.readyAt = Date.now() + T_READ; } }
    return send(res, 204);
  }
  if (p.startsWith('/__photo/')) {
    res.writeHead(200, { 'content-type': 'image/svg+xml', ...CORS });
    return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="280"><rect width="200" height="280" fill="#fff8e7"/></svg>');
  }
  const b = json(await readBody(req));
  if (p === '/__test/reset') { reset(b); return send(res, 200, { ok: true }); }
  if (p === '/__test/suggest') { S.suggest = b.on !== false; return send(res, 200, { ok: true }); } // la lecture propose deja 2 fiches (coupe avant la page 2)
  if (p === '/__test/seed') { seed(b); return send(res, 200, { folders: S.folders, docs: S.docs.map((d) => d.docId) }); } // fiches deja terminees, sans passer par un scan
  if (p === '/__test/role') { S.role = b.role === 'parent' ? 'parent' : 'eleve'; return send(res, 200, { ok: true }); }
  if (p === '/__test/history') { seedHistory(b); return send(res, 200, { tests: S.tests.length }); }
  if (p === '/__test/policy') { S.policyOutdated = b.outdated !== false; return send(res, 200, { ok: true }); }
  if (p === '/__test/fail') { S.fail = b.mode ?? null; return send(res, 200, { ok: true }); }
  if (p === '/__test/state') return send(res, 200, { jobs: S.jobs.length, docs: S.docs.length, cours: S.cours.length, pagesRemaining: S.pagesLimit - used(), uploadedBytes: S.jobs.reduce((a, j) => a + j.bytes, 0) });
  const parent = S.role === 'parent';
  const seg = p.split('/');
  const ID = seg[2] ? decodeURIComponent(seg[2]) : '';
  if (m === 'GET' && p === '/me') {
    if (parent) return S.family ? send(res, 200, { userId: 'u-parent', role: 'parent', familyId: S.family.familyId, ...(S.policyOutdated ? { policyOutdated: true } : {}) }) : err(res, 404, 'introuvable', 'Introuvable');
    const s = S.students[0];
    return send(res, 200, { userId: 'u-eleve', role: 'eleve', familyId: 'fam1', studentId: s.studentId, pseudo: s.pseudo });
  }
  if (m === 'POST' && p === '/family') {
    if (b.consent !== true) return err(res, 400, 'requete_invalide', 'Demande invalide');
    S.family = { familyId: 'fam1' };
    return send(res, 201, { userId: 'u-parent', role: 'parent', familyId: 'fam1' });
  }
  if (!S.family) return err(res, 404, 'introuvable', 'Introuvable');
  switch (`${m} ${p}`) {
    case 'GET /me/progress': return send(res, 200, progress());
    case 'GET /me/tests': return parent ? err(res, 403, 'interdit', 'Interdit') : send(res, 200, testPage(url.searchParams));
    case 'POST /family/policy':
      if (!parent) return err(res, 403, 'interdit', 'Interdit');
      if (b.consent !== true || b.policyVersion !== '2026-11-26') return err(res, 400, 'requete_invalide', 'Consentement requis');
      S.policyOutdated = false;
      return send(res, 204);
    case 'POST /family/export/archive':
      if (!parent) return err(res, 403, 'interdit', 'Interdit');
      if (S.archives >= 3) return err(res, 429, 'quota_epuise', "Trop d'archives demandées, réessaie dans une heure");
      S.archives += 1;
      return send(res, 200, { url: `${BASE}/__archive/${S.archives}.zip`, expiresAt: iso(Date.now() + 600e3), format: 'zip', sizeBytes: 48211, students: S.students.length, tests: S.tests.length, truncated: false });
    case 'GET /family/dashboard': return send(res, 200, { students: S.students.map((student) => ({ student, progress: progress() })), familyPagesRemaining: 50 - used(), familyPagesLimit: 50 });
    case 'GET /family/leaderboard': return send(res, 200, { week: '2099-W01', entries: S.students.map((s) => ({ studentId: s.studentId, pseudo: s.pseudo, xp: S.xp, activeDays: S.xp ? 1 : 0 })) });
    case 'GET /family/export': return send(res, 200, { familyId: 'fam1', exportedAt: iso(), students: S.students, docs: [], reports: [] });
    case 'POST /students': {
      if (!parent) return err(res, 403, 'interdit', 'Interdit');
      if (b.parentalAuthority !== true || !/^[A-Za-z][A-Za-z0-9 -]{1,19}$/.test(b.pseudo ?? '')) return err(res, 400, 'requete_invalide', 'Demande invalide');
      const student = { studentId: id('stu'), pseudo: `${b.pseudo}-7k2f`, schoolLevel: b.schoolLevel, under15: !!b.under15, status: 'actif', pageQuota: 20 };
      S.students.push(student);
      return send(res, 201, { student, activationLink: { url: 'http://127.0.0.1/activer#token=factice', expiresAt: iso(Date.now() + 86400e3) } });
    }
    case 'POST /scans': {
      const pages = Number(b.pages);
      if (!(pages >= 1 && pages <= 10) || b.contentTypes?.length !== pages || b.contentTypes.some((t) => !['image/jpeg', 'image/png'].includes(t))) return err(res, 400, 'requete_invalide', 'Demande invalide');
      if (pages > S.pagesLimit - used()) return err(res, 429, 'quota_epuise', 'Plus assez de pages ce mois-ci');
      if (b.folderId && !S.folders.some((f) => f.folderId === b.folderId)) return err(res, 404, 'introuvable', 'Dossier introuvable');
      const jobId = id('job');
      S.jobs.push({ jobId, pages, createdAt: iso(), state: 'en_attente_envoi', received: 0, bytes: 0, folderId: b.folderId });
      const uploads = Array.from({ length: pages }, (_, i) => ({ page: i + 1, url: `${BASE}/__s3/${jobId}/${i}`, fields: { key: `scans/${jobId}/${i}`, 'Content-Type': b.contentTypes[i] } }));
      return send(res, 201, { jobId, upload: uploads[0], uploads, expiresAt: iso(Date.now() + 900e3), pagesRemaining: S.pagesLimit - used() });
    }
    case 'GET /scans': { const l = listScans(url.searchParams); return l ? send(res, 200, l) : err(res, 404, 'introuvable', 'Introuvable'); }
    case 'GET /folders': return send(res, 200, { items: S.folders.map(folderOut).sort((a, c) => a.name.localeCompare(c.name, 'fr')) });
    case 'POST /folders': {
      const name = (b.name ?? '').replace(/[<>]/g, '').trim();
      if (!name) return err(res, 400, 'requete_invalide', 'Demande invalide');
      if (S.folders.length >= 50) return err(res, 400, 'dossiers_limite', 'Tu as atteint 50 dossiers');
      if (S.folders.some((f) => norm(f.name) === norm(name))) return err(res, 409, 'dossier_nom_pris', 'Nom déjà pris');
      const f = { folderId: id('fld'), name, createdAt: iso() };
      S.folders.push(f);
      return send(res, 201, folderOut(f));
    }
    case 'GET /docs': return send(res, 200, { items: S.docs.map(({ claims: _c, summary: _s, ...d }) => d) });
    case 'POST /answers': {
      const q = [...S.questions.values()].flat().find((x) => x.questionId === b.questionId);
      if (!q) return err(res, 400, 'requete_invalide', 'Question inconnue');
      const correct = norm(String(b.choice)) === norm(q.answer);
      if (correct) S.xp += 10;
      return send(res, 200, { correct, xpGained: correct ? 10 : 0, badges: [], ...(correct ? {} : { correctAnswer: q.answer }), progress: progress() });
    }
  }
  if (m === 'DELETE' && seg[1] === 'scans' && ID) {
    if (parent) return err(res, 403, 'interdit', 'Interdit');
    const j = S.jobs.find((x) => x.jobId === ID);
    if (!j || (j.state === 'rejete' && /^annul/i.test(j.message ?? ''))) return err(res, 404, 'introuvable', 'Introuvable');
    advance(j);
    if (!['en_attente_envoi', 'transcription', 'a_confirmer', 'rejete', 'echec', 'expire'].includes(j.state)) return err(res, 409, 'etat_invalide', 'Ce scan est déjà confirmé');
    Object.assign(j, { state: 'rejete', message: "Annulé par l'élève", refunded: true, finishedAt: iso() });
    return send(res, 204);
  }
  if (seg[1] === 'jobs') {
    const j = S.jobs.find((x) => x.jobId === ID);
    if (!j) return err(res, 404, 'introuvable', 'Introuvable');
    advance(j);
    if (m === 'GET' && !seg[3]) return send(res, 200, jobOut(j));
    if (parent) return err(res, 403, 'interdit', 'Interdit');
    if (m === 'GET' && seg[3] === 'transcription') {
      if (j.state !== 'a_confirmer') return err(res, 409, 'etat_invalide', 'Ce scan ne peut plus être relu');
      return send(res, 200, { jobId: j.jobId, docType: 'cours', pages: textOf(j), suggestedSubject: 'svt', suggestedTopic: 'La photosynthèse', ...(S.suggest && j.pages > 1 ? { suggestedSections: [{ fromSentenceId: 'p1-s1', subject: 'svt', topic: 'La photosynthèse' }, { fromSentenceId: 'p2-s1', subject: 'histoire_geo', topic: 'La Révolution française' }] } : {}), photoUrls: Array.from({ length: j.pages }, (_, i) => `${BASE}/__photo/${i}.svg`), photoUrlsExpireAt: iso(Date.now() + 300e3) });
    }
    if (m === 'POST' && seg[3] === 'confirm') {
      if (j.state !== 'a_confirmer') return err(res, 409, 'etat_invalide', 'Ce scan ne peut plus être confirmé');
      const e = confirm(j, b);
      return e ? err(res, ...e) : send(res, 200, jobOut(j));
    }
    if (m === 'POST' && seg[3] === 'cancel') {
      if (!['en_attente_envoi', 'transcription', 'a_confirmer'].includes(j.state)) return err(res, 409, 'etat_invalide', 'Trop tard pour annuler');
      Object.assign(j, { state: 'rejete', message: "Annulé par l'élève", refunded: true, finishedAt: iso() });
      return send(res, 200, jobOut(j));
    }
  }
  if (seg[1] === 'folders') {
    const f = S.folders.find((x) => x.folderId === ID);
    if (!f) return err(res, 404, 'introuvable', 'Introuvable');
    if (m === 'PATCH') {
      const name = (b.name ?? '').trim();
      if (!name) return err(res, 400, 'requete_invalide', 'Demande invalide');
      if (S.folders.some((x) => x !== f && norm(x.name) === norm(name))) return err(res, 409, 'dossier_nom_pris', 'Nom déjà pris');
      f.name = name;
      return send(res, 200, folderOut(f));
    }
    if (m === 'DELETE' && !seg[3]) { S.folders = S.folders.filter((x) => x !== f); S.docs.forEach((d) => { if (d.folderId === ID) delete d.folderId; }); return send(res, 204); }
    if (m === 'POST' && seg[3] === 'scans') {
      const ds = (b.docIds ?? []).map((d) => S.docs.find((x) => x.docId === d));
      if (!ds.length || ds.some((d) => !d)) return err(res, 404, 'introuvable', 'Introuvable');
      ds.forEach((d) => { d.folderId = ID; });
      return send(res, 200, folderOut(f));
    }
    if (m === 'DELETE' && seg[3] === 'scans') {
      const d = S.docs.find((x) => x.docId === seg[4] && x.folderId === ID);
      if (!d) return err(res, 404, 'introuvable', 'Introuvable');
      delete d.folderId;
      return send(res, 204);
    }
  }
  if (seg[1] === 'docs') {
    const d = S.docs.find((x) => x.docId === ID);
    if (!d) return err(res, 404, 'introuvable', 'Introuvable');
    const { jobId: _j, sectionIndex: _i, sectionCount: _n, ...pub } = d;
    if (m === 'GET' && !seg[3]) return send(res, 200, pub);
    if (m === 'DELETE') { S.docs = S.docs.filter((x) => x !== d); return send(res, 204); }
    if (m === 'POST' && seg[3] === 'read') {
      const first = !S.readToday.has(ID);
      S.readToday.add(ID);
      if (first) S.xp += 10;
      return send(res, 200, { xpGained: first ? 10 : 0, badges: [], progress: progress() });
    }
    if (m === 'GET' && seg[3] === 'session') return send(res, 200, { docId: ID, questions: (S.questions.get(ID) ?? []).map(({ answer: _a, ...q }) => q) });
  }
  if (seg[1] === 'cours') {
    if (parent) return err(res, 403, 'interdit', 'Interdit');
    const c = S.cours.find((x) => x.coursId === ID);
    if (!c) return err(res, 404, 'introuvable', 'Introuvable');
    if (m === 'GET') return send(res, 200, { ...c, sections: c.sections.map((s) => (s.docId && !S.docs.some((d) => d.docId === s.docId) ? { ...s, docId: undefined, status: 'supprimee' } : s)) });
    if (m === 'DELETE') {
      const mode = url.searchParams.get('fiches');
      if (!['garder', 'supprimer'].includes(mode)) return err(res, 400, 'requete_invalide', 'Demande invalide');
      S.cours = S.cours.filter((x) => x !== c);
      if (mode === 'supprimer') S.docs = S.docs.filter((d) => d.coursId !== ID);
      else S.docs.forEach((d) => { if (d.coursId === ID) { delete d.coursId; delete d.sectionIndex; delete d.sectionCount; } });
      return send(res, 204);
    }
  }
  if (seg[1] === 'me' && seg[2] === 'tests' && seg[3] && m === 'GET') {
    if (parent) return err(res, 403, 'interdit', 'Interdit');
    const t = S.tests.find((x) => x.testId === seg[3]);
    return t ? send(res, 200, t) : err(res, 404, 'introuvable', 'Introuvable');
  }
  if (seg[1] === 'students' && seg[3] && m === 'GET' && ['progress', 'tests'].includes(seg[3])) {
    if (!parent) return err(res, 403, 'interdit', 'Interdit');
    if (!S.students.some((x) => x.studentId === ID)) return err(res, 404, 'introuvable', 'Introuvable');
    if (seg[3] === 'progress') return send(res, 200, studentProgress());
    if (!seg[4]) return send(res, 200, testPage(url.searchParams));
    const t = S.tests.find((x) => x.testId === seg[4]);
    return t ? send(res, 200, parentView(t)) : err(res, 404, 'introuvable', 'Introuvable');
  }
  if (seg[1] === 'students') {
    const s = S.students.find((x) => x.studentId === ID);
    if (!s) return err(res, 404, 'introuvable', 'Introuvable');
    if (m === 'PATCH') { Object.assign(s, b); return send(res, 200, s); }
    if (m === 'DELETE') { S.students = S.students.filter((x) => x !== s); return send(res, 204); }
  }
  return err(res, 404, 'introuvable', `Route inconnue: ${m} ${p}`);
});
server.listen(PORT, '127.0.0.1', () => console.log(`API factice sur ${BASE}`));
