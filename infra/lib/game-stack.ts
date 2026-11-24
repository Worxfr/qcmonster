import { Stack, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { Env } from '../../shared/names.js';

export interface GameStackProps extends StackProps {
  envName: Env;
}

// Squelette vide (lot 1). Le contenu appartient au lot indique dans design-v2 10.2.
export class GameStack extends Stack {
  constructor(scope: Construct, id: string, props: GameStackProps) {
    super(scope, id, props);
  }
}
