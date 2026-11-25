import { Stack, type StackProps } from 'aws-cdk-lib';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { MODEL_KEYS, modelProfileName, ssmParam, type Env, type ModelKey } from '../../shared/names.js';

export interface ModelsStackProps extends StackProps {
  envName: Env;
}

/**
 * Profils systeme UE copies (design-v2 4.6). SEUL fichier du depot autorise a nommer un profil systeme.
 * [A verifier au premier deploiement: identifiants exacts dans la console Bedrock du compte, region eu-west-3.]
 */
export const SYSTEM_PROFILES: Record<ModelKey, string> = {
  haiku: 'eu.anthropic.claude-haiku-5-5',
  sonnet: 'eu.anthropic.claude-sonnet-5-5',
};

/** Regions UE du profil systeme `eu.` (a confirmer au premier deploiement). Les politiques IAM n'ouvrent le modele de base que dans ces regions (test M2: aucun joker de region). */
export const EU_REGIONS = ['eu-west-1', 'eu-west-3', 'eu-central-1', 'eu-north-1', 'eu-south-1', 'eu-south-2', 'eu-central-2'];

/**
 * Un profil d'inference d'APPLICATION par modele et par environnement (Haiku, Sonnet; dev ou prod: 4 au total),
 * tague Project/Environment/ManagedBy/Owner pour que le cout suive le tag. Le code appelle l'ARN de ce profil
 * (parametre SSM /qcm/<env>/models/<modele>), jamais le profil systeme.
 */
export class ModelsStack extends Stack {
  readonly profiles: Record<ModelKey, bedrock.CfnApplicationInferenceProfile>;

  constructor(scope: Construct, id: string, props: ModelsStackProps) {
    super(scope, id, props);
    const { envName } = props;
    const profiles = {} as Record<ModelKey, bedrock.CfnApplicationInferenceProfile>;
    for (const model of MODEL_KEYS) {
      const profile = new bedrock.CfnApplicationInferenceProfile(this, `Profile-${model}`, {
        inferenceProfileName: modelProfileName(envName, model),
        description: `QCMonster ${envName} ${model}`,
        modelSource: { copyFrom: this.formatArn({ service: 'bedrock', resource: 'inference-profile', resourceName: SYSTEM_PROFILES[model] }) },
      });
      profiles[model] = profile;
      new ssm.StringParameter(this, `Param-${model}`, {
        parameterName: ssmParam(envName, `models/${model}`),
        stringValue: profile.attrInferenceProfileArn,
      });
    }
    this.profiles = profiles;
  }
}
