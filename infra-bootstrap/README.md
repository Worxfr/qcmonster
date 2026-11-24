# Brancher GitHub Actions sur AWS pour QCMonster

Ce script permet à GitHub (repo `Worxfr/qcmonster`) de se connecter à AWS **sans mot de passe ni clé d'accès**. GitHub prouve son identité, et AWS lui prête un rôle pour quelques minutes.

## Ce que le script fait

- Il vérifie que vous êtes bien sur le compte `<ID_COMPTE>` (sinon il s'arrête).
- Il regarde si la connexion GitHub<->AWS (le « provider OIDC ») existe déjà. Les autres projets l'utilisent: s'il existe, **il n'y touche pas**. Il ne la crée que si elle manque.
- Il crée **un seul rôle à lui**: `QCMonster-GitHubActions-Deploy`, et **une seule policy à elle**: `QCMonster-GitHubActions-Deploy-Policy`.
- Le rôle n'est utilisable que par le repo `Worxfr/qcmonster`, depuis la branche `main` ou depuis un « environment » GitHub.
- Tout ce qu'il crée porte les tags `Project=QCMonster`, `Environment=prod`, `ManagedBy=script`, `Owner=Worxfr`.
- Il ne crée aucune clé d'accès et ne supprime rien (pas de mode « teardown »).
- Si le rôle ou la policy existent déjà et sont différents, il le signale mais ne les modifie pas.

## Utilisation

Dans votre terminal, connecté au compte AWS:

```bash
./setup-oidc.sh            # simulation: affiche le plan, ne crée rien
./setup-oidc.sh --apply    # crée vraiment
```

On peut le relancer: s'il n'y a rien à changer, il ne change rien.

Le script vérifie aussi en lecture seule que CDK est « bootstrappé » en `eu-west-3`. Sinon il affiche la commande à lancer vous-même: `npx cdk bootstrap aws://<ID_COMPTE>/eu-west-3`.

## Les droits donnés au rôle (le minimum)

1. Pouvoir « endosser » les rôles créés par le bootstrap CDK de ce compte en `eu-west-3`: `cdk-*-deploy-role-…`, `file-publishing-role`, `image-publishing-role`, `lookup-role`. Ce sont eux qui font le vrai déploiement.
2. Lire le paramètre SSM `/cdk-bootstrap/*/version` (CDK s'en sert pour vérifier que le bootstrap est présent).

Sources: documentation CDK, [Bootstrap your environment](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping-env.html) (liste des rôles `CloudFormationExecutionRole`, `DeploymentActionRole`, `FilePublishingRole`, `ImagePublishingRole`, `LookupRole`; noms `cdk-<qualifier>-<description>-<compte>-<région>`; paramètre `/cdk-bootstrap/hnb659fds/version`). Le script limite l'accès aux quatre rôles que le CDK endosse. Le rôle d'exécution CloudFormation n'est pas inclus: c'est CloudFormation qui l'utilise, pas GitHub.

## Utilisation dans GitHub Actions

À la fin, le script affiche l'ARN: `arn:aws:iam::<ID_COMPTE>:role/QCMonster-GitHubActions-Deploy`.

```yaml
permissions:
  id-token: write
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::<ID_COMPTE>:role/QCMonster-GitHubActions-Deploy
          aws-region: eu-west-3
      - run: npx cdk deploy --all --require-approval never
```

Note: si le job utilise `environment: Production`, c'est la forme `environment:*` qui sert. Les deux cas sont acceptés. Sur d'autres comptes de Worxfr, le `sub` du jeton a parfois contenu des identifiants numériques (`repo:Worxfr@123/...`). Si la connexion est refusée (`Not authorized to perform sts:AssumeRoleWithWebIdentity`), regardez le vrai `sub` dans CloudTrail avant de modifier la trust policy.

## Non inclus

- Pas de suppression (teardown).
- Pas de bootstrap CDK automatique.
- Pas de modification des rôles ou policies existants.

## Trust policy et `sub` immuable (depots recents)

Un depot recree recemment emet un `sub` de la forme `repo:Worxfr@<idProprietaire>/qcmonster@<idDepot>:environment:dev`.
Pour mettre a jour la trust policy d'un role existant (seul changement, rien d'autre n'est touche):

```bash
export EXPECTED_ACCOUNT=<ID_COMPTE>
export REPO_SUB_PREFIX="$(gh api repos/Worxfr/qcmonster/actions/oidc/customization/sub -q .sub_claim_prefix)"
./setup-oidc.sh --dry-run --update-trust   # verifier
./setup-oidc.sh --apply --update-trust
```
