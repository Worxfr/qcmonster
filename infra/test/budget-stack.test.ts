import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { BudgetStack } from '../lib/budget-stack.js';

const alarm = (envName: 'dev' | 'prod') => {
  const t = Template.fromStack(new BudgetStack(new App(), `B-${envName}`, { envName, alertEmail: 'a@example.org' }));
  return Object.values(t.findResources('AWS::CloudWatch::Alarm'))[0].Properties;
};

describe('alarme de cout applicatif (F12)', () => {
  it('dev: alerte a 80 EUR; prod: 10 EUR', () => {
    expect(alarm('dev')).toMatchObject({ AlarmName: 'qcm-dev-cout-mensuel-80', Threshold: 80 });
    expect(alarm('prod')).toMatchObject({ AlarmName: 'qcm-prod-cout-mensuel-10', Threshold: 10 });
  });
});
