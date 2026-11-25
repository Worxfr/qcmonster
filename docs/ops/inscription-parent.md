# Inscription d'un parent (procédure de référence)

Cette page remplace les consignes d'inscription par ligne de commande de `L5-report.md` (étape 2) et de `S1-report.md`: elles citaient le client Web, qui n'écrit plus aucun attribut depuis S1 (B2).

## Clients Cognito
| Client | Rôle | Sert à |
|---|---|---|
| `qcm-<env>-web` (`WebClientId`) | connexion de tous (SRP), aucun attribut en écriture | se connecter |
| `qcm-<env>-signup` (`SignupClientId`) | aucun flux de connexion, n'écrit que l'e-mail | `SignUp`, `ConfirmSignUp`, renvoi du code, mot de passe oublié |

Les deux identifiants sont des sorties de la stack `qcm-<env>-auth` (et `auth/webClientId`, `auth/signupClientId` en SSM). `scripts/front-env.mjs` les passe au build du front.

## Parcours normal (navigateur)
1. Le propriétaire génère un code: `npx tsx scripts/create-invite.ts --env=dev --apply` (droit `dynamodb:PutItem` sur la table `qcm-dev` seulement) ou le workflow manuel `invite` (une fois son rôle créé).
2. Le parent ouvre le site, « Créer un compte parent » (`#/inscription`): e-mail, mot de passe (12 caractères, majuscule, minuscule, chiffre), code d'invitation, consentement.
3. Il saisit le code à 6 chiffres reçu par e-mail. Connexion automatique, puis « Créer ma famille ».
4. Ensuite il se connecte avec son e-mail.

## Repli par ligne de commande
Seulement si le front est indisponible. L'identifiant ne peut pas avoir la forme d'un e-mail (l'e-mail est un alias de connexion).
```
aws cognito-idp sign-up --region eu-west-3 --client-id <SignupClientId> --username <identifiant> \
  --password '<12+ caractères, majuscule, minuscule, chiffre>' --user-attributes Name=email,Value=<e-mail> \
  --client-metadata inviteCode=<code>
aws cognito-idp confirm-sign-up --region eu-west-3 --client-id <SignupClientId> --username <identifiant> --confirmation-code <code reçu par e-mail>
```

## Invitation et confirmation (N13)
Le déclencheur `PreSignUp` consomme l'invitation à l'envoi du formulaire, pas à la confirmation. Choix assumé: une invitation ne peut ainsi donner qu'un seul compte, sans condition de course ni droit d'administration Cognito pour le déclencheur. Les restitutions possibles (réservation puis consommation par un déclencheur `PostConfirmation`, ou suppression des comptes non confirmés) exigent un second déclencheur ou `AdminDeleteUser`, et rouvrent la possibilité qu'un compte confirmé tardivement n'ait plus d'invitation valable. Conséquence: une faute de frappe dans l'e-mail, ou un code non reçu, brûle l'invitation; le propriétaire en génère une nouvelle. Le front permet de renvoyer le code (même e-mail) avant d'abandonner.
