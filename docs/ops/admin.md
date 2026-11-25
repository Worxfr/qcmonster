# Administration: générer des codes d'invitation parent

Depuis la version 1.2 du contrat, le propriétaire génère les codes d'invitation dans le site (page `#/admin`, « Invitations »), sans AWS CLI ni workflow. `scripts/create-invite.ts` reste disponible en repli (même format de code).

## Devenir administrateur
Le groupe Cognito `admin` est créé par la stack `qcm-<env>-auth`. Aucun utilisateur n'y est ajouté par le code: le propriétaire s'y ajoute lui-même, une seule fois, depuis son terminal avec ses identifiants AWS.

```
aws cognito-idp admin-add-user-to-group --region eu-west-3 \
  --user-pool-id <ID_POOL> --username <identifiant> --group-name admin
```

- `<ID_POOL>`: sortie `UserPoolId` de la stack `qcm-<env>-auth` (ou paramètre SSM `/qcm/<env>/auth/userPoolId`).
- `<identifiant>`: le nom d'utilisateur Cognito du compte (l'identifiant choisi à l'inscription).
- Le groupe figure dans le jeton à la connexion suivante: se déconnecter puis se reconnecter après la commande.
- Pour retirer le droit: `aws cognito-idp admin-remove-user-from-group` avec les mêmes paramètres.
- Un compte élève ne peut jamais être administrateur (le serveur refuse un jeton qui porte aussi le groupe `eleve`).

## Générer un code
1. Se connecter au site avec le compte administrateur. Le lien « Invitations » apparaît en haut (ou ouvrir `#/admin`).
2. Cliquer sur « Générer un code ». Le code (32 caractères) s'affiche **une seule fois**: le copier avec le bouton, puis le transmettre au parent.
3. Le code est à usage unique et n'est plus affiché ensuite (ni dans le site, ni dans les journaux, ni en base: seul son hachage SHA-256 est stocké). Perdu: en générer un autre.

## Quand le code est consommé
Le déclencheur `PreSignUp` consomme l'invitation à l'envoi du formulaire d'inscription du parent, pas à la confirmation de l'e-mail (voir `inscription-parent.md`, N13). Une faute de frappe dans l'e-mail brûle donc le code: en générer un nouveau.

## Garde-fous
- **Autorisation côté serveur**: la route `POST /admin/invitations` lit `cognito:groups` dans le jeton validé par API Gateway. Sans le groupe `admin` (parent, élève, jeton sans groupe): `403` identique, sans appel AWS. Le masquage du lien dans le site n'est qu'un confort.
- **Limite**: 20 codes par jour (UTC) et par administrateur; au-delà `429`. Réglage: constante `DAILY_LIMIT` dans `api/src/admin/invitations.ts`.
- **Audit**: chaque code crée un élément `INVITE#AUDIT#<auteur>#<aaaa-mm-jj>` (SK `N#nn`) avec l'événement, l'heure et l'auteur, et une ligne de journal `audit=invitation_creee actor=<auteur>`. L'auteur est les 16 premiers caractères du SHA-256 du `sub` Cognito (jamais le code). Les éléments d'audit expirent après un an (TTL).
- **Droits IAM**: la fonction `qcm-<env>-admin-invitations` n'a que `dynamodb:PutItem` sur la table, partitions `INVITE#*` (condition `dynamodb:LeadingKeys`). Aucun droit Cognito, aucune lecture. C'est pourquoi la limite passe par des écritures conditionnelles plutôt que par un compteur lu.
