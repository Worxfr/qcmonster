// API factice AVEC ETAT pour les tests de bout en bout en mode mock (aucun AWS).
// Prism (npm run mock) renvoie toujours les memes exemples: il ne permet pas de creer une famille puis d'envoyer des photos.
// Ce serveur suit le contrat shared/contract/openapi.yaml pour les routes utilisees par le front. Il n'ecrit rien sur disque.
// shortcut: un seul utilisateur a la fois (le role est fixe par POST /__test/reset), pas de jeton, pas de pagination (limit/cursor ignores).
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
// Version en vigueur lue dans shared/policy.ts: le mock ne doit pas la dupliquer.
const POLICY_VERSION = /POLICY_VERSION = '([0-9-]+)'/.exec(readFileSync(new URL('../../shared/policy.ts', import.meta.url), 'utf8'))[1];

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

// ---- ID1: surnoms (memes codes d'erreur que l'API; liste de mots reduite a un exemple) ----
const NICK_REFUSED = "Ce surnom n'est pas possible, essaie-en un autre";
const NICK_TAKEN = 'Ce surnom est déjà pris dans ta famille, essaie-en un autre';
const nickOk = (s) => typeof s === 'string' && /^[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ0-9 '-]{1,19}$/.test(s.trim()) && (s.match(/[0-9]/g) ?? []).length <= 2 && !/porn|connard/.test(norm(s));
const nameTaken = (name, self) => S.students.some((x) => x !== self && norm(x.displayName) === norm(name));
const SUFFIX = 'abcdefghjkmnpqrstuvwxyz23456789';
let sfx = 0;
const suffix = () => Array.from({ length: 5 }, (_, i) => SUFFIX[(++sfx * 7 + i * 3) % SUFFIX.length]).join('');

let S;
function reset({ role = 'eleve', family = true, student = true, pagesLimit = 20 } = {}) {
  S = { role, family: family ? { familyId: 'fam1' } : null, students: [], jobs: [], docs: [], cours: [], folders: [], xp: 0, readToday: new Set(), questions: new Map(), fail: null, pagesLimit, tests: [], policyOutdated: false, tokens: new Map(), archives: 0, bank: new Set(), seen: new Set(), docXp: new Map(), draw: null, exo: newExo() };
  if (family && student) S.students.push({ studentId: 'stu1', pseudo: 'lila-7k2fm', loginId: 'lila-7k2fm', displayName: 'Lila', schoolLevel: 'seconde', under15: false, status: 'actif', pageQuota: 20 });
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
  const docs = S.tests.length ? H_SUBJ.map(([matiere, titre], k) => { const mine = S.tests.filter((t) => t.docId === `doc${k}`); if (!mine.length) return null; return { docId: `doc${k}`, titre, matiere, pages: 2, createdAt: iso(), tests: mine.length, bestScorePct: Math.max(...mine.map((t) => t.scorePct)), lastScorePct: mine[0].scorePct, lastTestAt: mine[0].startedAt }; }).filter(Boolean) : [];
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

// R1 (contrat 1.5): `doubt` sur la 2e phrase de chaque page tant qu'elle n'est pas corrigee; phrases retirees (`removed`) absentes du cours conserve.
const textOf = (j, { review = false } = {}) => Array.from({ length: j.pages }, (_, i) => ({
  page: i + 1,
  sentences: PAGES[i % PAGES.length].map((t, k) => ({ id: `p${i + 1}-s${k + 1}`, text: j.fixed?.[`p${i + 1}-s${k + 1}`] ?? t, ...(review && k === 1 && !j.fixed?.[`p${i + 1}-s${k + 1}`] ? { doubt: true } : {}) })).filter((x) => !j.removed?.includes(x.id)),
}));
/** Blocs: un titre (1re phrase de la page 1), un paragraphe par page, et une figure `f1` apres le paragraphe de la page 1. */
const FIG_ALT = 'Schéma de la feuille avec les flèches du dioxyde de carbone';
const blocksOf = (j) => {
  const out = [];
  let b = 0;
  textOf(j).forEach((pg, i) => {
    const ids = pg.sentences.map((x) => x.id);
    if (i === 0 && ids.length) out.push({ id: `b${++b}`, kind: 'titre', level: 2, sentenceIds: [ids.shift()] });
    if (ids.length) out.push({ id: `b${++b}`, kind: 'paragraphe', sentenceIds: ids });
    if (i === 0) out.push({ id: `b${++b}`, kind: 'figure', figureId: 'f1' });
  });
  return out;
};
const figureOf = (j, kept = false) => ({ figureId: 'f1', page: 1, kind: 'schema', alt: j.figAlt ?? FIG_ALT, caption: 'Fig. 1', box: { x: 0.1, y: 0.4, w: 0.8, h: 0.35 }, url: `${BASE}/__photo/0.svg`, urlExpireAt: iso(Date.now() + 300e3), ...(kept ? {} : {}) });
const latexOk = (t) => { let n = 0; for (let k = 0; k < t.length; k++) { if (t[k] === '\\' && t[k + 1] === '$') k++; else if (t[k] === '$') n++; } return n % 2 === 0 && !/\\(href|url|input|include|def|htmlData|htmlClass)\b/.test(t); };

function makeDocs(j) {
  const all = textOf(j).flatMap((p) => p.sentences);
  const cours = { coursId: id('crs'), createdAt: j.createdAt, pages: j.pages, texts: textOf(j), sections: [], blocks: blocksOf(j).filter((b) => b.kind !== 'figure' || j.keepFigure), figures: j.keepFigure ? [figureOf(j)] : [], marks: [] };
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
    // Q1: une banque de `questions` questions variees (regles du vrai serveur: tirage, 409 hors tirage, 50 XP au plus par fiche).
    if (x.questions !== undefined) {
      S.bank.add(docId);
      S.questions.set(docId, Array.from({ length: x.questions }, (_, i) => {
        const k = i + 1;
        return k % 2 ? { questionId: `${docId}-b${k}`, kind: 'qcm', prompt: `Question ${k} sur ${x.title}`, choices: [`Bonne ${k}`, 'Faux A', 'Faux B', 'Faux C'], answer: `Bonne ${k}` }
          : { questionId: `${docId}-b${k}`, kind: 'gap', prompt: `Complète ${x.title} ${k} : ____`, answer: `mot${k}` };
      }));
    }
  }
}

// ---- Q1: tirage, controle du tirage, plafond de 50 XP par fiche (memes regles que le vrai serveur) ----
const DOC_CAP = 50;
const publicQ = (q, d) => { const { answer: _a, ...r } = q; return d ? { ...r, docId: d.docId, docTitle: d.title } : r; };
const docOf = (qid) => S.docs.find((d) => qid.startsWith(`${d.docId}-`));
/** Tirage: a tour de role entre fiches, les questions jamais repondues d'abord. */
function drawFrom(docs, size) {
  const queues = docs.map((d) => {
    const qs = [...(S.questions.get(d.docId) ?? [])];
    return [...qs.filter((q) => !S.seen.has(q.questionId)), ...qs.filter((q) => S.seen.has(q.questionId))];
  });
  const out = [];
  while (out.length < size && queues.some((q) => q.length)) for (const q of queues) if (q.length && out.length < size) out.push(q.shift());
  return out;
}
const SIZES = [5, 10, 15, 20];
const paidOf = (docId) => S.docXp.get(docId) ?? 0;
function openDraw(docs, qs, scope, titre) {
  S.draw = { testId: id('tst'), ids: qs.map((q) => q.questionId), docIds: docs.map((d) => d.docId), scope, titre, answers: new Map() };
}
function practice(res, b) {
  const hasDocs = b.docIds !== undefined;
  if (hasDocs === (b.folderId !== undefined)) return err(res, 400, 'requete_invalide', 'Requête invalide');
  if (b.size !== undefined && !SIZES.includes(b.size)) return err(res, 400, 'requete_invalide', 'Requête invalide');
  const size = b.size ?? 10;
  const skipped = [];
  let docs = [];
  let scope = 'fiches';
  let folderName = '';
  if (hasDocs) {
    if (!Array.isArray(b.docIds) || b.docIds.length < 1 || b.docIds.length > 10 || new Set(b.docIds).size !== b.docIds.length) return err(res, 400, 'requete_invalide', 'Requête invalide');
    for (const i of b.docIds) {
      const d = S.docs.find((x) => x.docId === i);
      if (d) docs.push(d); else skipped.push({ docId: i, reason: 'introuvable' });
    }
  } else {
    const f = S.folders.find((x) => x.folderId === b.folderId);
    if (!f) return err(res, 404, 'introuvable', 'Introuvable');
    scope = 'dossier';
    folderName = f.name;
    docs = S.docs.filter((d) => d.folderId === f.folderId).slice(0, 10);
  }
  const usable = [];
  for (const d of docs) {
    if ((S.questions.get(d.docId) ?? []).length === 0) skipped.push({ docId: d.docId, title: d.title, reason: 'sans_question' });
    else usable.push(d);
  }
  if (!usable.length) return err(res, 409, 'aucune_question', 'Aucune question pour le moment');
  const qs = drawFrom(usable, size);
  const avail = usable.reduce((n, d) => n + (S.questions.get(d.docId) ?? []).length, 0);
  const title = scope === 'dossier' ? folderName : `${usable.length} fiches`;
  openDraw(usable, qs, scope, title);
  return send(res, 200, { scope, title, docIds: usable.map((d) => d.docId), questions: qs.map((q) => publicQ(q, docOf(q.questionId))), available: avail, short: qs.length < size, xpRemaining: usable.map((d) => ({ docId: d.docId, xpRemaining: Math.max(0, DOC_CAP - paidOf(d.docId)) })), skipped });
}
function answerBank(res, b) {
  const d = docOf(b.questionId);
  if (!S.draw || !S.draw.ids.includes(b.questionId)) return err(res, 409, 'etat_invalide', "Ouvre d'abord un test");
  if (!d) return err(res, 404, 'introuvable', 'Introuvable');
  const q = (S.questions.get(d.docId) ?? []).find((x) => x.questionId === b.questionId);
  const correct = norm(String(b.choice)) === norm(q.answer);
  let gain = 0;
  let capped = false;
  const first = !S.seen.has(q.questionId);
  if (correct && first) {
    gain = Math.min(5, Math.max(0, DOC_CAP - paidOf(d.docId)));
    capped = gain < 5;
    S.docXp.set(d.docId, paidOf(d.docId) + gain);
    S.xp += gain;
  }
  S.seen.add(q.questionId);
  // Passage de l'historique: un seul pour tout le test, quel que soit le nombre de fiches.
  const dr = S.draw;
  let t = S.tests.find((x) => x.testId === dr.testId);
  if (!t) {
    const multi = dr.docIds.length > 1 || dr.scope === 'dossier';
    t = { testId: dr.testId, docId: dr.docIds[0], titre: multi ? dr.titre : d.title, matiere: 'autre', mode: 'mixte', schoolYear: schoolYearOf(Date.now()), startedAt: iso(), total: dr.ids.length, answered: 0, correct: 0, firstTry: 0, scorePct: 0, xpGained: 0, status: 'incomplet', ...(multi ? { scope: dr.scope, docIds: dr.docIds } : {}), questions: [] };
    S.tests.unshift(t);
  }
  if (!t.questions.some((x) => x.questionId === q.questionId)) {
    t.questions.push({ questionId: q.questionId, rank: dr.ids.indexOf(q.questionId) + 1, kind: q.kind, correct, attempts: 1, firstTry: correct, xpGained: gain, answeredAt: iso(), choice: String(b.choice), prompt: q.prompt, ...(q.choices ? { choices: q.choices } : {}), correctAnswer: q.answer });
    t.answered = t.questions.length;
    t.correct = t.questions.filter((x) => x.correct).length;
    t.firstTry = t.correct;
    t.xpGained += gain;
    t.scorePct = Math.round((100 * t.correct) / t.total);
    t.status = t.answered >= t.total ? 'complet' : 'incomplet';
    t.endedAt = iso();
  }
  return send(res, 200, { correct, xpGained: gain, ...(capped ? { capped: true } : {}), badges: [], ...(correct ? {} : { correctAnswer: q.answer }), progress: progress() });
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
  const removed = b.removed ?? [];
  if (removed.some((r) => !all.some((s) => s.id === r))) return [400, 'requete_invalide', 'Phrase inconnue'];
  if ((b.figures ?? []).some((f) => f.figureId !== 'f1')) return [400, 'requete_invalide', 'Figure inconnue'];
  for (const c of b.corrections ?? []) { if (!latexOk(c.text ?? '')) return [400, 'requete_invalide', 'Formule non valide']; if (!all.some((s) => s.id === c.id) || !c.text?.trim()) return [400, 'requete_invalide', 'Demande invalide']; fixed[c.id] = c.text; }
  if ([b.folderId, ...(b.sections ?? []).map((x) => x.folderId)].some((f) => f && !S.folders.some((x) => x.folderId === f))) return [404, 'introuvable', 'Dossier introuvable'];
  const kept = all.filter((x) => !removed.includes(x.id));
  if (removed.includes(b.sections?.[0]?.fromSentenceId ?? '')) return [400, 'requete_invalide', 'Phrase de départ inconnue'];
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
  Object.assign(j, { removed, keepFigure: (b.figures ?? []).some((f) => f.keep), figAlt: (b.figures ?? []).find((f) => f.keep)?.alt, fixed, sections: secs, state: 'verification', confirmedAt: Date.now() });
  return null;
}

// ---- E1: exercices et correction de copie (contrat 1.9.0). Petit automate fidele au contrat; aucun appel de modele. ----
// Horloge simulee (`S.exo.skew`, avance par POST /__test/exo) pour le delai de 60 s, les 10 minutes avant la solution, le jour. Aucune attente reelle.
// shortcut: les corrections sont deterministes (1re: 2 etapes sur 4 et finale fausse; ensuite: tout juste); les copies se resolvent a la 2e interrogation.
const EXO_STEPS_1 = [
  { id: 'e1', libelle: 'Choisir la bonne formule', statut: 'ok', indice: 'Bien vu : tu relies la distance et la durée.' },
  { id: 'e2', libelle: 'Convertir la durée', statut: 'partiel', indice: "Regarde l'unité de la durée avant de calculer." },
  { id: 'e3', libelle: 'Calculer le quotient', statut: 'faux', indice: 'Relis ton calcul de la division.' },
];
const EXO_STEPS_2 = EXO_STEPS_1.map((s) => ({ ...s, statut: 'ok', indice: 'Bien joué.' }));
const EXO_ENONCES = [
  ['Vitesse moyenne', 'Un cycliste roule 30 km en 1,5 h.\nCalcule sa vitesse moyenne en $\\mathrm{km/h}$.\nOn rappelle que $v = \\dfrac{d}{t}$.'],
  ['Une fonction affine', 'Soit $f(x) = 3x - 5$.\nCalcule $f(4)$, puis trouve le nombre $x$ tel que $f(x) = 7$.'],
  ['Énergie cinétique', 'Une balle de masse $m = 0{,}2\\ \\mathrm{kg}$ roule à $v = 3\\ \\mathrm{m/s}$.\nCalcule son énergie cinétique $E_c = \\dfrac{1}{2} m v^2$.'],
  ['Pourcentage', 'Un article coûte 40 €. Son prix augmente de $15\\ \\%$.\nCalcule le nouveau prix.'],
  ['Théorème de Pythagore', 'Un triangle $ABC$ est rectangle en $A$ avec $AB = 6$ et $AC = 8$.\nCalcule $BC$.'],
];
function newExo() {
  return { exos: [], copies: [], skew: 0, day: 1, seq: 0, pagesUsed: 0, correctionsToday: 0, genToday: new Map(), flags: { illisible: 0, quota: false, tooShort: false } };
}
const exoNow = () => Date.now() + S.exo.skew;
const exoMonth = () => new Date(exoNow()).toISOString().slice(0, 7);
const nextMonth = () => { const d = new Date(exoNow()); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString(); };
const maxXp = (exo) => Math.round(10 * (1 - 0.2 * exo.indicesDonnes.length));
const exoResume = (x) => ({ exoId: x.exoId, titre: x.titre, etat: x.etat, points: 10, ...(x.meilleurMilli !== undefined ? { meilleurMilli: x.meilleurMilli } : {}), xpPaye: x.xpPaye, solutionVue: x.solutionVue });
const exoPublic = (x) => {
  const ready = x.etat === 'prete';
  return {
    exoId: x.exoId, docId: x.docId, etat: x.etat, ...(ready ? { titre: x.titre, enonce: x.enonce } : {}), points: 10,
    indicesVus: x.indicesDonnes.length, indicesTotal: 3, indicesDonnes: x.indicesDonnes, nbCopies: x.nbCopies, copiesRestantes: Math.max(0, 3 - x.nbCopies), solutionVue: x.solutionVue,
  };
};
function addExo(docId, etat = 'prete') {
  const k = S.exo.exos.filter((x) => x.docId === docId).length;
  const [titre, enonce] = EXO_ENONCES[k % EXO_ENONCES.length];
  const x = { exoId: `${docId}.${String(k + 1).padStart(2, '0')}`, docId, etat, polls: 0, titre, enonce, indicesDonnes: [], lastHintAt: 0, openedAt: 0, nbCopies: 0, xpPaye: 0, solutionVue: false, hints: ['Pense à la formule qui relie les grandeurs.', "Regarde les unités : sont-elles les mêmes partout ?", 'Écris chaque calcul sur une ligne, puis vérifie le résultat.'] };
  S.exo.exos.push(x);
  return x;
}
const stepsOf = (c) => (c.k >= 2 ? EXO_STEPS_2 : EXO_STEPS_1);

/** Credit a la premiere lecture d'une copie corrigee (idempotent), comme `GET /copies/{id}` du contrat. */
function creditCopie(c, exo) {
  if (c.credite) return;
  c.credite = true;
  const doc = S.docs.find((d) => d.docId === exo.docId);
  const gain = exo.solutionVue ? 0 : Math.max(0, Math.floor(maxXp(exo) * (c.scoreMilli / 1000)) - exo.xpPaye);
  c.xpGagne = gain;
  exo.xpPaye += gain;
  exo.meilleurMilli = Math.max(exo.meilleurMilli ?? 0, c.scoreMilli);
  S.xp += gain;
  const steps = stepsOf(c);
  const lines = [...steps.map((s, i) => ({ id: s.id, ok: s.statut === 'ok', rank: i + 1 })), { id: 'f', ok: c.finale.statut === 'juste', rank: steps.length + 1 }];
  const nn = exo.exoId.split('.').pop();
  const test = {
    testId: `01JF5EX0${String(S.exo.seq++).padStart(18, '0')}`, docId: exo.docId, titre: doc?.title ?? exo.titre, matiere: doc?.subject ?? 'maths', mode: 'exercice', schoolYear: schoolYearOf(Date.now()), startedAt: iso(), endedAt: iso(),
    total: lines.length, answered: lines.length, correct: lines.filter((l) => l.ok).length, firstTry: c.k === 1 ? lines.filter((l) => l.ok).length : 0, scorePct: Math.round((100 * lines.filter((l) => l.ok).length) / lines.length), xpGained: gain, status: 'complet',
    questions: lines.map((l) => ({ questionId: `${exo.docId}:exo:${nn}#${l.id}`, rank: l.rank, kind: 'exo', correct: l.ok, attempts: 1, firstTry: c.k === 1 && l.ok, xpGained: 0, answeredAt: iso() })),
  };
  S.tests.unshift(test);
}
function copieOut(c, exo) {
  if (c.etat === 'en_correction' && ++c.gets >= 3) { // resolue a la 3e interrogation (le mode strict de React en fait 2 au montage)
    if (S.exo.flags.illisible > 0) { S.exo.flags.illisible -= 1; c.etat = 'illisible'; }
    else { c.etat = 'corrigee'; exo.nbCopies += 1; c.k = exo.nbCopies; const st = stepsOf(c); c.scoreMilli = c.k >= 2 ? 1000 : 600; c.finale = { libelle: 'Vitesse moyenne', statut: c.k >= 2 ? 'juste' : 'fausse' }; const good = st.filter((s) => s.statut === 'ok').length + (c.k >= 2 ? 1 : 0); c.bilan = `${good} ${good > 1 ? 'étapes' : 'étape'} sur ${st.length + 1}`; }
    S.exo.correctionsToday += 1;
  }
  if (c.etat === 'corrigee') creditCopie(c, exo);
  const base = { copieId: c.copieId, exoId: c.exoId, etat: c.etat, solutionVue: exo.solutionVue };
  if (c.etat !== 'corrigee') return base;
  return { ...base, etapes: stepsOf(c), finale: c.finale, scoreMilli: c.scoreMilli, bilan: c.bilan, xpGagne: c.xpGagne };
}

/** Routes E1. Renvoie true si la requete est traitee. Le parent n'a acces a rien (403). */
function exoRoutes(res, m, seg, b, parent) {
  const E = S.exo;
  const isDocExo = seg[1] === 'docs' && seg[3] === 'exercices';
  const isExo = seg[1] === 'exercices' && seg[2];
  const isCopie = seg[1] === 'copies' && seg[2];
  if (!isDocExo && !isExo && !isCopie) return false;
  if (parent) return err(res, 403, 'interdit', 'Interdit'), true;
  const nf = () => (err(res, 404, 'introuvable', 'Introuvable'), true);
  const id = decodeURIComponent(seg[2] ?? '');
  if (isDocExo) {
    const d = S.docs.find((x) => x.docId === id);
    if (!d) return nf();
    if (m === 'GET') return send(res, 200, { items: E.exos.filter((x) => x.docId === id).map(exoResume) }), true;
    if (m === 'POST') {
      if (!['maths', 'physique'].includes(d.subject)) return err(res, 409, 'matiere_non_prevue', 'Les exercices existent pour les maths et la physique-chimie'), true;
      if (E.flags.tooShort) return err(res, 409, 'fiche_trop_courte', 'Cette fiche est trop courte'), true;
      if (E.exos.filter((x) => x.docId === id).length >= 5 || (E.genToday.get(id) ?? 0) >= 1 || [...E.genToday.values()].reduce((a, n) => a + n, 0) >= 5) return err(res, 409, 'plafond_exercices', 'Tu as atteint la limite d’exercices'), true;
      E.genToday.set(id, (E.genToday.get(id) ?? 0) + 1);
      const x = addExo(id, 'generation');
      return send(res, 202, { exoId: x.exoId, etat: 'generation' }), true;
    }
    return false;
  }
  if (isExo) {
    const x = E.exos.find((e) => e.exoId === id);
    if (!x) return nf();
    if (m === 'GET' && !seg[3]) {
      if (x.etat === 'generation' && ++x.polls >= 3) x.etat = 'prete'; // prete a la 3e interrogation
      if (x.etat === 'prete' && !x.openedAt) x.openedAt = exoNow();
      return send(res, 200, exoPublic(x)), true;
    }
    if (m === 'POST' && seg[3] === 'indice') {
      if (x.indicesDonnes.length >= 3) return err(res, 409, 'etat_invalide', 'Plus d’indice'), true;
      x.indicesDonnes.push(x.hints[x.indicesDonnes.length]);
      x.lastHintAt = exoNow();
      return send(res, 200, { rang: x.indicesDonnes.length, texte: x.indicesDonnes.at(-1), indicesRestants: 3 - x.indicesDonnes.length }), true;
    }
    if (m === 'POST' && seg[3] === 'solution') {
      const corrected = E.copies.some((c) => c.exoId === id && c.etat === 'corrigee');
      if (!x.solutionVue && !corrected && !(x.indicesDonnes.length === 3 && exoNow() - x.lastHintAt >= 600e3)) return err(res, 409, 'pas_encore', "Essaie d'abord l'exercice"), true;
      x.solutionVue = true;
      return send(res, 200, { solution: 'On utilise $v = \\dfrac{d}{t}$, donc $v = \\dfrac{30}{1{,}5} = 20\\ \\mathrm{km/h}$.' }), true;
    }
    if (m === 'POST' && seg[3] === 'copies') {
      if (!(b.pages >= 1 && b.pages <= 3) || !['image/jpeg', 'image/png'].includes(b.contentType)) return err(res, 400, 'requete_invalide', 'Demande invalide'), true;
      if (E.copies.some((c) => c.etat === 'en_correction')) return err(res, 409, 'deja_en_cours', 'Une correction est déjà en cours'), true;
      if (E.flags.quota || E.pagesUsed + b.pages > 40) return send(res, 409, { code: 'quota_copies', message: 'Plus assez de pages de copie ce mois-ci', resetDate: nextMonth() }), true;
      if (x.nbCopies >= 3 || E.correctionsToday >= 5) return err(res, 409, 'plafond_copies', 'Tu as déjà rendu cet exercice 3 fois'), true;
      E.copies = E.copies.filter((c) => c.etat !== 'a_envoyer'); // une seule copie a envoyer: la nouvelle remplace l'ancienne
      const copieId = `01JCOPIE${String(++E.seq).padStart(18, '0')}`;
      E.copies.push({ copieId, exoId: id, etat: 'a_envoyer', pages: b.pages, received: 0, gets: 0 });
      const envois = Array.from({ length: b.pages }, (_, i) => ({ page: i + 1, url: `${BASE}/__s3c/${copieId}/${i + 1}`, fields: { key: `copies/stu1/${copieId}/p${i + 1}`, 'Content-Type': b.contentType } }));
      return send(res, 201, { copieId, envois, expireA: iso(Date.now() + 600e3) }), true;
    }
    return false;
  }
  const c = E.copies.find((k) => k.copieId === id);
  const exo = c && E.exos.find((e) => e.exoId === c.exoId);
  if (!c || !exo) return nf();
  if (m === 'POST' && seg[3] === 'submit') {
    if (c.etat !== 'a_envoyer') return err(res, 409, 'etat_invalide', 'Cette copie est déjà envoyée'), true;
    if (c.received < c.pages) return err(res, 400, 'requete_invalide', 'Il manque une page'), true;
    if (E.copies.some((k) => k.etat === 'en_correction')) return err(res, 409, 'deja_en_cours', 'Une correction est déjà en cours'), true;
    if (exo.nbCopies >= 3 || E.correctionsToday >= 5) return err(res, 409, 'plafond_copies', 'Tu as déjà rendu cet exercice 3 fois'), true;
    if (exoNow() - exo.openedAt < 60e3) return err(res, 409, 'trop_tot', "Prends le temps de faire l'exercice"), true;
    E.pagesUsed += c.pages;
    c.etat = 'en_correction';
    return send(res, 202, { etat: 'en_correction' }), true;
  }
  if (m === 'GET' && !seg[3]) return send(res, 200, copieOut(c, exo)), true;
  if (m === 'DELETE' && !seg[3]) {
    if (c.etat === 'en_correction') return err(res, 409, 'en_correction', 'La correction est en cours'), true;
    E.copies = E.copies.filter((k) => k !== c);
    return send(res, 204), true;
  }
  return false;
}

/** Pilotage des tests: horloge, jour suivant, quota atteint, copie illisible, fiche trop courte, exercices deja prets (`seed`). */
function exoTest(b) {
  const E = S.exo;
  if (b.skewMs) E.skew += Number(b.skewMs);
  if (b.nextDay) { E.day += 1; E.genToday.clear(); E.correctionsToday = 0; }
  if (b.quota !== undefined) E.flags.quota = !!b.quota;
  if (b.illisible !== undefined) E.flags.illisible = Number(b.illisible);
  if (b.tooShort !== undefined) E.flags.tooShort = !!b.tooShort;
  if (b.seed) for (let i = 0; i < b.seed.count; i++) { const x = addExo(b.seed.docId); if (b.seed.xpPaye && i === 0) { x.xpPaye = b.seed.xpPaye; x.meilleurMilli = 600; } }
  return { exos: E.exos.map((x) => x.exoId), copies: E.copies.length };
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
  if (p.startsWith('/__s3c/')) { // faux S3 des copies: une page par POST
    const body = await readBody(req);
    const c = S.exo.copies.find((x) => x.copieId === p.split('/')[2]);
    if (S.fail === 's3') return err(res, 500, 'erreur', 'panne');
    if (c && body.length) c.received += 1;
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
  if (p === '/__test/exo') return send(res, 200, exoTest(b));
  if (p === '/__test/fail') { S.fail = b.mode ?? null; return send(res, 200, { ok: true }); }
  if (p === '/__test/state') return send(res, 200, { jobs: S.jobs.length, docs: S.docs.length, cours: S.cours.length, pagesRemaining: S.pagesLimit - used(), uploadedBytes: S.jobs.reduce((a, j) => a + j.bytes, 0) });
  const parent = S.role === 'parent';
  const seg = p.split('/');
  const ID = seg[2] ? decodeURIComponent(seg[2]) : '';
  if (m === 'GET' && p === '/me') {
    if (parent) return S.family ? send(res, 200, { userId: 'u-parent', role: 'parent', familyId: S.family.familyId, ...(S.policyOutdated ? { policyOutdated: true } : {}) }) : err(res, 404, 'introuvable', 'Introuvable');
    const s = S.students[0];
    return send(res, 200, { userId: 'u-eleve', role: 'eleve', familyId: 'fam1', studentId: s.studentId, pseudo: s.loginId, loginId: s.loginId, displayName: s.displayName });
  }
  if (m === 'POST' && p === '/family') {
    if (b.consent !== true) return err(res, 400, 'requete_invalide', 'Demande invalide');
    S.family = { familyId: 'fam1' };
    return send(res, 201, { userId: 'u-parent', role: 'parent', familyId: 'fam1' });
  }
  if (!S.family) return err(res, 404, 'introuvable', 'Introuvable');
  if (exoRoutes(res, m, seg, b, parent)) return;
  switch (`${m} ${p}`) {
    case 'GET /me/progress': return send(res, 200, progress());
    case 'GET /me/tests': return parent ? err(res, 403, 'interdit', 'Interdit') : send(res, 200, testPage(url.searchParams));
    case 'DELETE /family':
      if (!parent) return err(res, 403, 'interdit', 'Interdit');
      S.family = null;
      S.students = [];
      return send(res, 204);
    case 'POST /family/policy':
      if (!parent) return err(res, 403, 'interdit', 'Interdit');
      if (b.consent !== true || b.policyVersion !== POLICY_VERSION) return err(res, 400, 'requete_invalide', 'Consentement requis');
      S.policyOutdated = false;
      return send(res, 204);
    case 'POST /family/export/archive':
      if (!parent) return err(res, 403, 'interdit', 'Interdit');
      if (S.archives >= 3) return err(res, 429, 'quota_epuise', "Trop d'archives demandées, réessaie dans une heure");
      S.archives += 1;
      return send(res, 200, { url: `${BASE}/__archive/${S.archives}.zip`, expiresAt: iso(Date.now() + 600e3), format: 'zip', sizeBytes: 48211, students: S.students.length, tests: S.tests.length, truncated: false });
    case 'GET /family/dashboard': return send(res, 200, { students: S.students.map((student) => ({ student, progress: progress() })), familyPagesRemaining: 50 - used(), familyPagesLimit: 50 });
    case 'GET /family/leaderboard': return send(res, 200, { week: '2099-W01', entries: S.students.map((s) => ({ studentId: s.studentId, pseudo: s.displayName, xp: S.xp, activeDays: S.xp ? 1 : 0 })) });
    case 'GET /family/export': return send(res, 200, { familyId: 'fam1', exportedAt: iso(), students: S.students, docs: [], reports: [] });
    case 'POST /students': {
      if (!parent) return err(res, 403, 'interdit', 'Interdit');
      if (b.parentalAuthority !== true || !/^[A-Za-z][A-Za-z0-9 -]{1,19}$/.test(b.pseudo ?? '')) return err(res, 400, 'requete_invalide', 'Demande invalide');
      if (!nickOk(b.pseudo)) return err(res, 400, 'pseudo_refuse', NICK_REFUSED);
      if (nameTaken(b.pseudo)) return err(res, 409, 'pseudo_pris', NICK_TAKEN);
      const loginId = `${norm(b.pseudo).replace(/[^a-z0-9]+/g, '-')}-${suffix()}`;
      const student = { studentId: id('stu'), pseudo: loginId, loginId, displayName: b.pseudo.trim(), schoolLevel: b.schoolLevel, under15: !!b.under15, status: 'actif', pageQuota: 20 };
      S.students.push(student);
      const token = `factice-${student.studentId}-0123456789abcdef`;
      S.tokens.set(token, student.studentId);
      return send(res, 201, { student, activationLink: { url: `http://127.0.0.1/activer#token=${token}`, expiresAt: iso(Date.now() + 86400e3) } });
    }
    case 'POST /activation': {
      // Meme ordre que l'API: jeton d'abord (404 unique), surnom controle AVANT de consommer le jeton, puis 200 avec l'identifiant.
      const sid = S.tokens.get(b.token);
      const s = sid && S.students.find((x) => x.studentId === sid);
      if (!s) return err(res, 404, 'introuvable', 'Introuvable');
      if (typeof b.password !== 'string' || b.password.length < 12) return err(res, 400, 'requete_invalide', 'Mot de passe refusé');
      if (b.displayName !== undefined) {
        if (!nickOk(b.displayName)) return err(res, 400, 'pseudo_refuse', NICK_REFUSED);
        if (nameTaken(b.displayName, s)) return err(res, 409, 'pseudo_pris', NICK_TAKEN);
        s.displayName = b.displayName.trim();
      }
      S.tokens.delete(b.token);
      return send(res, 200, { loginId: s.loginId, displayName: s.displayName });
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
    case 'GET /docs': return send(res, 200, { items: S.docs.map(({ claims: _c, summary: _s, ...d }) => ({ ...d, exerciceCount: S.exo.exos.filter((x) => x.docId === d.docId).length })) });
    case 'POST /practice/session': return parent ? err(res, 403, 'interdit', 'Interdit') : practice(res, b);
    case 'POST /answers': {
      const bq = [...S.bank].some((d) => String(b.questionId).startsWith(`${d}-`));
      if (bq) return answerBank(res, b);
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
      return send(res, 200, { jobId: j.jobId, docType: 'cours', pages: textOf(j, { review: true }), blocks: blocksOf(j), figures: [figureOf(j)], suggestedSubject: 'svt', suggestedTopic: 'La photosynthèse', ...(S.suggest && j.pages > 1 ? { suggestedSections: [{ fromSentenceId: 'p1-s1', subject: 'svt', topic: 'La photosynthèse' }, { fromSentenceId: 'p2-s1', subject: 'histoire_geo', topic: 'La Révolution française' }] } : {}), photoUrls: Array.from({ length: j.pages }, (_, i) => `${BASE}/__photo/${i}.svg`), photoUrlsExpireAt: iso(Date.now() + 300e3) });
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
    if (m === 'GET' && !seg[3]) {
      if (parent) return send(res, 200, pub);
      const c = S.cours.find((x) => x.coursId === d.coursId);
      const body = [{ heading: 'À retenir', text: `${pub.summary} Voici la formule $E = mc^{2}$.`, claimIds: pub.claims.slice(0, 1).map((x) => x.claimId) }, { text: 'Deuxième paragraphe de la fiche.' }];
      const recall = pub.claims.slice(0, 2).map((x, k) => ({ kind: k ? 'date' : 'definition', text: x.text, claimId: x.claimId, verified: x.status === 'verifiee' }));
      return send(res, 200, { ...pub, claims: pub.claims.map((x) => ({ ...x, sentenceId: 'p1-s1' })), body, recall, ...(c?.figures?.length ? { figures: c.figures } : {}) });
    }
    if (m === 'DELETE') { S.docs = S.docs.filter((x) => x !== d); return send(res, 204); }
    if (m === 'POST' && seg[3] === 'read') {
      const first = !S.readToday.has(ID);
      S.readToday.add(ID);
      if (first) S.xp += 10;
      return send(res, 200, { xpGained: first ? 10 : 0, badges: [], progress: progress() });
    }
    if (m === 'GET' && seg[3] === 'session') {
      if (!S.bank.has(ID)) return send(res, 200, { docId: ID, questions: (S.questions.get(ID) ?? []).map(({ answer: _a, ...q }) => q) });
      const size = url.searchParams.get('size') === null ? 10 : Number(url.searchParams.get('size'));
      if (!SIZES.includes(size)) return err(res, 400, 'requete_invalide', 'Requête invalide');
      const qs = drawFrom([d], size);
      openDraw([d], qs, 'fiche', d.title);
      return send(res, 200, { docId: ID, questions: qs.map((q) => publicQ(q)), available: (S.questions.get(ID) ?? []).length, short: qs.length < size, xpRemaining: Math.max(0, DOC_CAP - paidOf(ID)) });
    }
  }
  if (seg[1] === 'me' && seg[2] === 'export' && seg[3] === 'archive') {
    if (parent) return err(res, 403, 'interdit', 'Interdit');
    S.exports ??= new Map();
    if (m === 'POST' && !seg[4]) {
      const exportId = id('exp');
      S.exports.set(exportId, { at: Date.now() });
      return send(res, 202, { exportId, state: 'en_cours' });
    }
    if (m === 'GET' && seg[4]) {
      const e = S.exports.get(seg[4]);
      if (!e) return err(res, 404, 'introuvable', 'Introuvable');
      if (Date.now() - e.at < T_STEP) return send(res, 200, { exportId: seg[4], state: 'en_cours' });
      return send(res, 200, { exportId: seg[4], state: 'pret', archive: { url: `${BASE}/__export/${seg[4]}.zip`, expiresAt: iso(Date.now() + 600e3), format: 'zip', sizeBytes: 482113, students: 1, tests: S.tests.length, truncated: false, courses: S.cours.length, figures: S.cours.reduce((n, c) => n + c.figures.length, 0), omittedCourses: 0 } });
    }
  }
  if (seg[1] === 'cours') {
    if (parent) return err(res, 403, 'interdit', 'Interdit');
    const c = S.cours.find((x) => x.coursId === ID);
    if (!c) return err(res, 404, 'introuvable', 'Introuvable');
    if (m === 'GET') return send(res, 200, { ...c, figureCount: c.figures.length, marks: S.docs.filter((d) => d.coursId === ID).flatMap((d) => d.claims.slice(0, 2).map((x, k) => ({ sentenceId: x.sentenceId ?? `p1-s${k + 1}`, status: ['verifiee', 'erreur', 'non_verifiable'][k % 3], docId: d.docId, claimId: x.claimId }))), sections: c.sections.map((s) => (s.docId && !S.docs.some((d) => d.docId === s.docId) ? { ...s, docId: undefined, status: 'supprimee' } : s)) });
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
    if (m === 'POST' && seg[3] === 'login-id') { s.loginId = `${s.loginId.replace(/-[a-z0-9]{4,5}$/, '')}-${suffix()}`; s.pseudo = s.loginId; return send(res, 200, { loginId: s.loginId }); }
    if (m === 'PATCH') {
      if (b.displayName !== undefined) {
        if (!nickOk(b.displayName)) return err(res, 400, 'pseudo_refuse', NICK_REFUSED);
        if (nameTaken(b.displayName, s)) return err(res, 409, 'pseudo_pris', NICK_TAKEN);
        b.displayName = b.displayName.trim();
      }
      Object.assign(s, b);
      return send(res, 200, s);
    }
    if (m === 'DELETE') { S.students = S.students.filter((x) => x !== s); return send(res, 204); }
  }
  return err(res, 404, 'introuvable', `Route inconnue: ${m} ${p}`);
});
server.listen(PORT, '127.0.0.1', () => console.log(`API factice sur ${BASE}`));
