import { Stack, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { Env } from '../../shared/names.js';

export interface ModelsStackProps extends StackProps {
  envName: Env;
}

// Squelette vide (lot 1). Le contenu appartient au lot indique dans design-v2 10.2.
export class ModelsStack extends Stack {
  constructor(scope: Construct, id: string, props: ModelsStackProps) {
    super(scope, id, props);
  }
}
