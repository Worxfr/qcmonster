# Tests de bout en bout

Ces tests ouvrent le vrai site dans un navigateur (Chromium sans écran, format PC) et refont le parcours d'un élève et d'un parent.
Ils vivent dans un dossier à part (`e2e/`), avec leurs propres dépendances. Ils ne changent rien au site.

## Mode « mock » (par défaut, sans AWS)

Le site tourne en local avec la connexion simulée, et une fausse API (`e2e/mock-api/server.mjs`) garde les données en mémoire.
Rien ne sort de ta machine.

```bash
npm ci                      # à la racine du repo, une fois
cd e2e
npm ci
npx playwright install chromium
npm test
```

Durée : environ 40 secondes. La CI le lance sur chaque PR (job `e2e`, en parallèle des autres vérifications).

## Mode « dev » (à la main, jamais en CI)

Le test vise le site dev réel. Les identifiants viennent de l'environnement, ils ne sont écrits nulle part.

```bash
cd e2e
export E2E_MODE=dev
export E2E_BASE_URL='https://adresse-du-site-dev'
export E2E_USER='pseudo-eleve-de-test'
export E2E_PASSWORD='mot-de-passe-eleve-de-test'
# facultatif, pour la vue parent :
export E2E_PARENT_USER='pseudo-parent-de-test'
export E2E_PARENT_PASSWORD='mot-de-passe-parent-de-test'
# vrais scans autorisés (0 par défaut, 2 au maximum) :
export E2E_REAL_SCANS=2
npm test
```

Lancer le parcours complet avec un vrai scan (mode dev, `E2E_REAL_SCANS=1`) :

```bash
cd e2e
export E2E_MODE=dev E2E_REAL_SCANS=1
# avec E2E_BASE_URL, E2E_USER et E2E_PASSWORD déjà exportés comme ci-dessus
npx playwright test tests/03-parcours-cours.spec.ts
```

Coût attendu : 1 scan de 3 pages pour le parcours complet (`E2E_REAL_SCANS=1`), 2 avec `E2E_REAL_SCANS=2` (parcours + annulation). Moins de 0,50 € au total, un appel à Claude par scan, aucun autre appel payant.
Durée : environ 3 à 6 minutes. La lecture réelle d'un scan prend 2 minutes environ ; si la lecture propose déjà 2 fiches, le test les garde (il ne coupe pas).

Délais : chaque action du navigateur est limitée à 30 s, chaque test à 6 min (60 s en mock). La seule longue attente est la lecture du scan (5 min au plus).

- `E2E_REAL_SCANS=0` : aucun vrai scan. Les tests qui envoient des photos sont sautés. Les tests d'erreurs sans envoi tournent quand même.
- Chaque vrai scan coûte un appel à Claude (moins de 0,5 € pour 3 pages). Le parcours complet en utilise 1, l'annulation 1.
- En mode dev, il n'y a ni capture, ni vidéo, ni trace (elles pourraient montrer l'identifiant tapé). `E2E_CAPTURES=1` active les captures d'échec.
- Les tests qui créent une famille ou un élève ne tournent qu'en mode mock.

## Ce qui est testé

Connexion et déconnexion, création de famille, ajout d'un élève, envoi de 3 images, liste des scans avec statut, relecture
(correction, découpe en 2 fiches, confirmation), fiche, QCM, texte à trous, points, dossiers et tri, vue parent sans texte de cours,
suppression d'un cours, erreurs (annulation, 11e photo, fichier trop gros, mauvais type, panne d'envoi, quota).

## Fichiers produits

Captures, vidéos et traces des échecs vont dans `e2e/.artifacts/`, les images fabriquées dans `e2e/.tmp/`. Les deux sont ignorés par git.
Aucune image n'est stockée dans le repo : les pages de cours sont dessinées par le navigateur au moment du test.
