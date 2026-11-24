// Verification des tags obligatoires sur un template CloudFormation synthetise.
export const REQUIRED_TAGS = ['Project', 'Environment', 'ManagedBy', 'Owner'] as const;

// Types de ressources sans propriete de tags dans CloudFormation (ou dependantes d'une ressource deja taguee).
// Tout autre type DOIT porter les 4 tags: un nouveau type non liste echoue tant qu'il n'est pas tague.
export const UNTAGGABLE = new Set([
  'AWS::CDK::Metadata',
  'AWS::IAM::Policy',
  'AWS::IAM::ManagedPolicy',
  'AWS::Lambda::Permission',
  'AWS::Cognito::UserPoolClient',
  'AWS::Cognito::UserPoolGroup',
  'AWS::SNS::Subscription',
  'AWS::S3::BucketPolicy',
  'AWS::ApiGatewayV2::Authorizer',
  'AWS::ApiGatewayV2::Integration',
  'AWS::ApiGatewayV2::Route',
  'AWS::Budgets::BudgetsAction',
]);

type Res = { Type: string; Properties?: Record<string, unknown> };

const tagKeys = (props: Record<string, unknown> = {}): string[] => {
  const raw = (props.Tags ?? props.UserPoolTags ?? props.ResourceTags) as unknown;
  if (Array.isArray(raw)) return raw.map((t) => (t as { Key: string }).Key);
  if (raw && typeof raw === 'object') return Object.keys(raw);
  return [];
};

/** Renvoie les violations "<LogicalId> (<Type>): tag X manquant". Liste vide = conforme. */
export function missingTags(template: { Resources?: Record<string, Res> }): string[] {
  const out: string[] = [];
  for (const [id, r] of Object.entries(template.Resources ?? {})) {
    if (UNTAGGABLE.has(r.Type)) continue;
    const have = tagKeys(r.Properties);
    for (const t of REQUIRED_TAGS) if (!have.includes(t)) out.push(`${id} (${r.Type}): tag ${t} manquant`);
  }
  return out;
}
