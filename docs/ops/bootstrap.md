# Bootstrap AWS (a executer par le propriétaire, dans son terminal)

L'agent ne lance AUCUNE commande AWS qui cree ou modifie quoi que ce soit. Ces etapes touchent IAM et le compte
`<ID_COMPTE>` (region `eu-west-3`): elles sont a lancer par le propriétaire, avec ses identifiants.

Ordre: 1 → 2 → 3 → 4 → 5 → 6. Cocher chaque etape et noter la sortie dans `docs/acceptance/L1.md`.

## 1. Confirmer le compte et valider l'estimation de cout

Ecrire « oui » dans `docs/decisions.md` (lot 0): compte `<ID_COMPTE>` confirme, estimation de `docs/design-v2.md` section 8
validee (environ 10 EUR/mois pour une famille en scenario realiste, 16,6 EUR au pire). Rien n'est deploye avant.

## 2. Connexion GitHub ↔ AWS sans cle d'acces (OIDC)

```bash
cd infra-bootstrap
export EXPECTED_ACCOUNT=<ID_COMPTE>   # tape la valeur toi-meme: elle n'est jamais dans le depot
./setup-oidc.sh            # simulation: affiche le plan
./setup-oidc.sh --apply    # cree le role QCMonster-GitHubActions-Deploy
```

Le script (`infra-bootstrap/setup-oidc.sh`) reutilise le fournisseur OIDC existant, ne cree qu'un role
et une policy dediees, et ne supprime rien. Voir `infra-bootstrap/README.md`.

## 3. Bootstrap CDK

```bash
npx cdk bootstrap aws://<ID_COMPTE>/eu-west-3
```

## 4. Activer la cle de tag de couts `project`

Le budget filtre par tag ne voit rien tant que la cle n'est pas activee (gratuit, jusqu'a 24 h de delai).
Console: Billing → Cost allocation tags → activer `project` (et `Environment`). Verifier avant de creer les budgets:

```bash
aws ce list-cost-allocation-tags --status Active
```

La cle est `project` en minuscules, valeur `qcmonster`. Ne jamais poser `Project` (majuscule): IAM compare les cles sans tenir compte de la casse, et deux ecritures differentes sur une meme ressource echouent.

## 5. Configurer GitHub (depot public `Worxfr/qcmonster`)

- Environnements GitHub `dev` et `prod`: **limites a la branche `main`**, et **relecteur obligatoire sur `prod`**. Ils sont crees avec la limite a `main` par l'agent (API GitHub); a verifier dans Settings → Environments. **Depot public**: les relecteurs requis sont disponibles sur le plan gratuit pour un depot public (l'API les avait refuses tant que le depot etait prive). Les ajouter apres le passage en public (Settings → Environments → prod → Required reviewers). Tant qu'ils ne sont pas poses, la garde de `prod` est: lancement manuel seulement, depuis `main`, apres `dev`, et `DEPLOY_ENABLED=true`. La trust policy du role n'accepte que les `sub` exacts `environment:dev` et `environment:prod` (plus `ref:refs/heads/main`, retire en L5): sans cette limite, toute branche pourrait declarer un environnement.
- **Secret de depot `AWS_ACCOUNT_ID`** (masque dans les journaux; le workflow en construit l'ARN du role; l'ID n'est jamais dans le code). Il est cree par l'agent a la creation du depot; pour le recreer, tape la valeur toi-meme:

  ```bash
  gh secret set AWS_ACCOUNT_ID --repo Worxfr/qcmonster
  ```

- Variable d'environnement `ALERT_EMAIL` (adresse qui recoit les alertes de cout) dans `dev` et dans `prod`. Ce n'est pas un secret.
- **Aucune cle d'acces AWS** dans le depot: `gh secret list` ne doit montrer que `AWS_ACCOUNT_ID` (un identifiant de compte, pas un identifiant de connexion).
- Quand tout ce qui precede est fait: variable de depot `DEPLOY_ENABLED=true`. Tant qu'elle n'existe pas, un push sur `main` ne deploie rien.
- Premiere fois: lancer le workflow `deploy` a la main (Actions → deploy → Run workflow → `dev`).

## 6. Apres le premier deploiement

- Confirmer l'abonnement e-mail SNS (message de confirmation AWS recu a `ALERT_EMAIL`).
- Stack `budget` (prod seulement pour les budgets, qui sont propres au compte): creer les budgets `QCMonster-alerte-20`,
  `QCMonster-filet-marketplace`, `QCMonster-securite-40`. L'**action** du budget securite est desactivee par defaut (elle cible
  les roles `qcm-prod-pipeline-role` et `qcm-prod-verify-role` des lots L2a/L2b, qui n'existent pas encore). Une fois ces
  lots deployes: `npx cdk deploy qcm-prod-budget -c env=prod -c budgetAction=true`.
  - [ ] **Controle J+2 fait avant `-c budgetAction=true`**: Cost Explorer filtre par tag `project` ET par entite AWS Marketplace
    montre les appels de modeles apres le premier appel reel (design 4.6 point 4). Tant que ce n'est pas coche, la coupure
    automatique ne voit peut-etre pas Bedrock: seuls le compteur applicatif (15/18 EUR) et le budget Marketplace protegent.
- Creer un code d'invitation parent (aucun parent ne peut s'inscrire sans): `npx tsx scripts/create-invite.ts --env=dev` (simulation),
  puis `--apply` pour ecrire dans la table. La table `qcm-<env>` est creee par la stack `data` (a venir).
- Test negatif OIDC (acceptation L1 n.2): depuis un depot prive jetable cree par le propriétaire, tenter `AssumeRoleWithWebIdentity`
  sur le role; l'echec doit etre colle dans `docs/acceptance/L1.md`.

## Ce que l'agent n'a PAS fait

Aucun deploiement, aucune commande `aws` d'ecriture, aucun secret. `cdk synth` local uniquement.
