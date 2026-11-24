import { Stack, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { Env } from '../../shared/names.js';

export interface VerifyStackProps extends StackProps {
  envName: Env;
}

// Squelette vide (lot 1). Le contenu appartient au lot indique dans design-v2 10.2.
export class VerifyStack extends Stack {
  constructor(scope: Construct, id: string, props: VerifyStackProps) {
    super(scope, id, props);
  }
}
