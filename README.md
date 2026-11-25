# QCMonster

Application PWA de revision pour lyceens (scan d'un cours → fiche verifiee, QCM, textes a trous, gamification).
Conception: `docs/design-v2.md`. Region `eu-west-3`, compte `<ID_COMPTE>`.

## Structure (un repertoire = un lot proprietaire, design-v2 10.1)

| Chemin | Contenu |
|---|---|
| `shared/` | contrat OpenAPI (`shared/contract/openapi.yaml`), types et Zod generes, `ddb/keys.ts`, `quota.ts`, `cost.ts`, `pricing.ts`, `names.ts`, `log/` |
| `infra/` | CDK TypeScript: `bin/app.ts` complet, une stack par fichier dans `lib/` |
| `api/` | Lambda (lot 1: declencheur Cognito `auth/pre-signup.ts`) |
| `mock/` | API simulee: `npm run mock` (Prism, port 4010) puis `npm run mock:check` |
| `web/` | front React/Vite (squelette) |
| `docs/` | `data-model.md`, `ops/bootstrap.md`, [schémas d'architecture](docs/architecture/README.md) |
| `infra-bootstrap/` | `setup-oidc.sh` (lance par le propriétaire) |

## Commandes

```bash
npm ci
npm run gen        # regenere types et schemas Zod depuis openapi.yaml (ne jamais les editer a la main)
npm run lint && npm run typecheck && npm test
cd infra && npx cdk synth -c env=dev --quiet   # QCM_ALERT_EMAIL=... pour l'adresse d'alerte
```

`cdk.json` lance `npx tsx bin/app.ts` (TypeScript direct, pas de JS compile).

## Regles

- Jamais de secret, de cle AWS ni de photo d'essai dans git (`samples/` est ignore). Deploiement par OIDC seulement.
- Tags `Project`, `Environment`, `ManagedBy`, `Owner` sur toute ressource (test CI).
- Aucun `modelId` systeme (`eu.anthropic...`): uniquement des ARN de profils d'application (test CI).
- Journaux par `shared/log` seulement, jamais de console (test CI).
- Changer le contrat ou le schema de donnees: PR relue par le proprietaire du lot 1.
