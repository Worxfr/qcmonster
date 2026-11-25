#!/usr/bin/env bash
# Branche GitHub Actions (Worxfr/qcmonster) sur AWS par OIDC, sans toucher aux autres projets.
# Par défaut: simulation (--dry-run). Utiliser --apply pour créer.
set -euo pipefail

# L'ID du compte n'est JAMAIS ecrit dans ce depot: il est fourni par l'environnement (obligatoire).
: "${EXPECTED_ACCOUNT:?EXPECTED_ACCOUNT est obligatoire (ID du compte AWS attendu), ex: EXPECTED_ACCOUNT=<ID_COMPTE> ./setup-oidc.sh}"
case "$EXPECTED_ACCOUNT" in *[!0-9]*|"") echo "EXPECTED_ACCOUNT doit etre un ID de 12 chiffres" >&2; exit 2 ;; esac
[ "${#EXPECTED_ACCOUNT}" -eq 12 ] || { echo "EXPECTED_ACCOUNT doit etre un ID de 12 chiffres" >&2; exit 2; }
REGION="eu-west-3"
REPO="Worxfr/qcmonster"
ROLE_NAME="QCMonster-GitHubActions-Deploy"
POLICY_NAME="QCMonster-GitHubActions-Deploy-Policy"
OIDC_HOST="token.actions.githubusercontent.com"
PROVIDER_ARN="arn:aws:iam::${EXPECTED_ACCOUNT}:oidc-provider/${OIDC_HOST}"
POLICY_ARN="arn:aws:iam::${EXPECTED_ACCOUNT}:policy/${POLICY_NAME}"
TAGS_CLI=(Key=Project,Value=QCMonster Key=Environment,Value=prod Key=ManagedBy,Value=script Key=Owner,Value=Worxfr)

# Prefixe du claim `sub`. Depots recents: forme immuable avec identifiants numeriques (repo:Worxfr@<id>/qcmonster@<id>),
# a lire avec: gh api repos/Worxfr/qcmonster/actions/oidc/customization/sub -q .sub_claim_prefix
# N9: OBLIGATOIRE. Un prefixe par defaut (repo:Worxfr/qcmonster) ne correspond pas aux jetons des depots a sujet immuable: la trust policy
# serait remplacee par une valeur que GitHub n'emet plus, et le deploiement s'arreterait.
: "${REPO_SUB_PREFIX:?REPO_SUB_PREFIX est obligatoire. Le lire avec: gh api repos/${REPO}/actions/oidc/customization/sub -q .sub_claim_prefix}"
case "$REPO_SUB_PREFIX" in repo:*) ;; *) echo "REPO_SUB_PREFIX doit commencer par « repo: » (valeur lue par gh api, champ sub_claim_prefix)" >&2; exit 2 ;; esac
SUB_PREFIX="$REPO_SUB_PREFIX"
UPDATE_TRUST=0
[ "${2:-}" = "--update-trust" ] && UPDATE_TRUST=1

APPLY=0
case "${1:-}" in
  ""|--dry-run) APPLY=0 ;;
  --apply) APPLY=1 ;;
  *) echo "Usage: $0 [--dry-run | --apply]   (défaut: --dry-run)" >&2; exit 2 ;;
esac

export AWS_PAGER="" AWS_DEFAULT_REGION="$REGION"

# Toute commande qui ÉCRIT passe par w(): en simulation elle est seulement affichée.
w() {
  if [ "$APPLY" -eq 1 ]; then
    echo "  > aws $*"
    aws "$@"
  else
    echo "  [simulation] aws $*"
  fi
}

same_json() {
  python3 -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1]))==json.load(open(sys.argv[2])) else 1)' "$1" "$2"
}

# --- Garde-fou compte ---
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
echo "Compte AWS connecté : $ACCOUNT (attendu : $EXPECTED_ACCOUNT), région : $REGION"
if [ "$ACCOUNT" != "$EXPECTED_ACCOUNT" ]; then
  echo "ERREUR: mauvais compte. Arrêt." >&2
  exit 1
fi
if [ "$APPLY" -eq 1 ]; then echo "Mode : APPLY (écritures réelles)"; else echo "Mode : SIMULATION (aucune écriture). Ajouter --apply pour agir."; fi

# --- Documents JSON ---
TRUST="$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"Federated": "${PROVIDER_ARN}"},
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {"${OIDC_HOST}:aud": "sts.amazonaws.com", "${OIDC_HOST}:sub": [
        "${SUB_PREFIX}:environment:dev",
        "${SUB_PREFIX}:environment:prod"
      ]}
    }
  }]
}
JSON
)"

POLICY="$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AssumeCdkBootstrapRoles",
      "Effect": "Allow",
      "Action": "sts:AssumeRole",
      "Resource": [
        "arn:aws:iam::${EXPECTED_ACCOUNT}:role/cdk-*-deploy-role-${EXPECTED_ACCOUNT}-${REGION}",
        "arn:aws:iam::${EXPECTED_ACCOUNT}:role/cdk-*-file-publishing-role-${EXPECTED_ACCOUNT}-${REGION}",
        "arn:aws:iam::${EXPECTED_ACCOUNT}:role/cdk-*-image-publishing-role-${EXPECTED_ACCOUNT}-${REGION}",
        "arn:aws:iam::${EXPECTED_ACCOUNT}:role/cdk-*-lookup-role-${EXPECTED_ACCOUNT}-${REGION}"
      ]
    },
    {
      "Sid": "ReadCdkBootstrapVersion",
      "Effect": "Allow",
      "Action": "ssm:GetParameter",
      "Resource": "arn:aws:ssm:${REGION}:${EXPECTED_ACCOUNT}:parameter/cdk-bootstrap/*/version"
    }
  ]
}
JSON
)"

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
printf '%s' "$TRUST"  > "$TMP/trust.json"
printf '%s' "$POLICY" > "$TMP/policy.json"

echo; echo "=== PLAN ==="

# 1) Provider OIDC: réutilisé s'il existe, jamais modifié.
PROVIDER_STATE="absent"
if aws iam list-open-id-connect-providers --query 'OpenIDConnectProviderList[].Arn' --output text | tr '\t' '\n' | grep -qx "$PROVIDER_ARN"; then
  PROVIDER_STATE="existe"
fi
if [ "$PROVIDER_STATE" = existe ]; then
  echo "1. Provider OIDC GitHub : existe -> réutilisé, non modifié"
else
  echo "1. Provider OIDC GitHub : absent -> sera créé"
fi

# 2) Policy gérée dédiée
POLICY_STATE="absente"
if aws iam get-policy --policy-arn "$POLICY_ARN" >/dev/null 2>&1; then POLICY_STATE="existe"; fi
echo "2. Policy $POLICY_NAME : $POLICY_STATE"

# 3) Rôle dédié
ROLE_STATE="absent"
if aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then ROLE_STATE="existe"; fi
echo "3. Rôle $ROLE_NAME : $ROLE_STATE"

# 4) CDK bootstrap (lecture seule)
BOOT="$(aws ssm get-parameters-by-path --path /cdk-bootstrap/ --recursive --query 'Parameters[?ends_with(Name, `/version`)].Name' --output text 2>/dev/null || true)"
if [ -n "$BOOT" ]; then
  echo "4. CDK bootstrap en $REGION : OK ($BOOT)"
else
  echo "4. CDK bootstrap en $REGION : ABSENT. À faire par vous (le script ne le fait pas) :"
  echo "     npx cdk bootstrap aws://${EXPECTED_ACCOUNT}/${REGION}"
fi

echo; echo "=== ACTIONS ==="
# En cas de différence sur une ressource existante, on n'écrase jamais: on le signale.
if [ "$PROVIDER_STATE" = absent ]; then
  w iam create-open-id-connect-provider --url "https://${OIDC_HOST}" --client-id-list sts.amazonaws.com \
    --tags "${TAGS_CLI[@]}"
fi

if [ "$POLICY_STATE" = absente ]; then
  w iam create-policy --policy-name "$POLICY_NAME" --policy-document "file://$TMP/policy.json" \
    --description "Deploiement CDK QCMonster via GitHub Actions" --tags "${TAGS_CLI[@]}"
else
  CUR="$(aws iam get-policy --policy-arn "$POLICY_ARN" --query Policy.DefaultVersionId --output text)"
  aws iam get-policy-version --policy-arn "$POLICY_ARN" --version-id "$CUR" --query PolicyVersion.Document --output json > "$TMP/cur-policy.json"
  if same_json "$TMP/cur-policy.json" "$TMP/policy.json"; then
    echo "  Policy identique: rien à faire."
  else
    echo "  ATTENTION: la policy existante diffère. Non modifiée (à relire à la main)."
  fi
fi

if [ "$ROLE_STATE" = absent ]; then
  w iam create-role --role-name "$ROLE_NAME" --assume-role-policy-document "file://$TMP/trust.json" \
    --description "GitHub Actions ${REPO} -> deploiement CDK" --max-session-duration 3600 --tags "${TAGS_CLI[@]}"
  w iam attach-role-policy --role-name "$ROLE_NAME" --policy-arn "$POLICY_ARN"
else
  aws iam get-role --role-name "$ROLE_NAME" --query Role.AssumeRolePolicyDocument --output json > "$TMP/cur-trust.json"
  if same_json "$TMP/cur-trust.json" "$TMP/trust.json"; then
    echo "  Trust policy identique: rien à faire."
  else
    if [ "$UPDATE_TRUST" -eq 1 ]; then
      echo "  Trust policy differente: mise a jour (--update-trust)."
      w iam update-assume-role-policy --role-name "$ROLE_NAME" --policy-document "file://$TMP/trust.json"
    else
      echo "  ATTENTION: la trust policy du rôle diffère. Non modifiée (relancer avec: --apply --update-trust)."
    fi
  fi
  if aws iam list-attached-role-policies --role-name "$ROLE_NAME" --query 'AttachedPolicies[].PolicyArn' --output text | tr '\t' '\n' | grep -qx "$POLICY_ARN"; then
    echo "  Policy déjà attachée: rien à faire."
  else
    w iam attach-role-policy --role-name "$ROLE_NAME" --policy-arn "$POLICY_ARN"
  fi
fi

echo; echo "=== RÉSULTAT ==="
echo "ARN du rôle à mettre dans role-to-assume :"
echo "  arn:aws:iam::${EXPECTED_ACCOUNT}:role/${ROLE_NAME}"
if [ "$APPLY" -eq 0 ]; then echo "(Simulation terminée: rien n'a été créé.)"; fi
