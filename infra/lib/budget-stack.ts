import { Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import type { Construct } from 'constructs';
import { COST_ALERT_EUR, METRIC_COST_MONTH, METRIC_NAMESPACE, processingRoleNames, type Env } from '../../shared/names.js';
import { USD_PER_EUR } from '../../shared/pricing.js';

export interface BudgetStackProps extends StackProps {
  envName: Env;
  alertEmail: string;
}

type Notif = { type: 'ACTUAL' | 'FORECASTED'; threshold: number };
const usd = (eur: number) => Math.round(eur * USD_PER_EUR * 100) / 100;

/**
 * Budget (design-v2 4.6): trois budgets AWS + alarme sur le compteur applicatif.
 * Les montants sont en EUR dans le design; AWS Budgets les compte dans la devise de facturation du compte (USD
 * suppose), donc convertis avec USD_PER_EUR. Les cles de tag `Project` doivent etre ACTIVEES comme tags de repartition
 * des couts (docs/ops/bootstrap.md) AVANT le deploiement, sinon le budget filtre par tag ne voit rien.
 */
export class BudgetStack extends Stack {
  constructor(scope: Construct, id: string, props: BudgetStackProps) {
    super(scope, id, props);
    const { envName, alertEmail } = props;
    const subscribers = [{ subscriptionType: 'EMAIL', address: alertEmail }];
    const notifs = (list: Notif[]) =>
      list.map((n) => ({
        notification: { notificationType: n.type, comparisonOperator: 'GREATER_THAN', threshold: n.threshold, thresholdType: 'PERCENTAGE' },
        subscribers,
      }));
    const monthly = (name: string, eur: number, costFilters: Record<string, string[]>, list: Notif[]) =>
      new budgets.CfnBudget(this, name, {
        budget: {
          budgetName: `QCMonster-${name}`,
          budgetType: 'COST',
          timeUnit: 'MONTHLY',
          budgetLimit: { amount: usd(eur), unit: 'USD' },
          costFilters,
        },
        notificationsWithSubscribers: notifs(list),
      });

    // Les budgets sont propres au COMPTE (filtre par tag Project, tous environnements): crees par la stack prod seulement,
    // sinon dev et prod creeraient des doublons.
    if (envName === 'prod') {
      const tagFilter = { TagKeyValue: ['user:Project$QCMonster'] };
      // 1. Alerte 20 EUR, filtre par tag Project=QCMonster. Seuils 50/80/100 % reels, 100 % prevision.
      monthly('alerte-20', 20, tagFilter, [
        { type: 'ACTUAL', threshold: 50 },
        { type: 'ACTUAL', threshold: 80 },
        { type: 'ACTUAL', threshold: 100 },
        { type: 'FORECASTED', threshold: 100 },
      ]);
      // 2. Filet Marketplace 25 EUR (modeles Claude factures via AWS Marketplace). Alerte seulement, aucune action.
      monthly('filet-marketplace', 25, { BillingEntity: ['AWS Marketplace'] }, [
        { type: 'ACTUAL', threshold: 80 },
        { type: 'ACTUAL', threshold: 100 },
      ]);
      // 3. Securite 40 EUR, filtre par tag, avec action: politique IAM qui refuse bedrock:InvokeModel* aux Lambda de traitement.
      monthly('securite-40', 40, tagFilter, [{ type: 'ACTUAL', threshold: 100 }]);

      const denyBedrock = new iam.ManagedPolicy(this, 'DenyBedrockInvoke', {
        managedPolicyName: `QCMonster-${envName}-deny-bedrock-invoke`,
        description: 'Appliquee par le budget securite-40: coupe les appels de modeles',
        statements: [
          new iam.PolicyStatement({
            effect: iam.Effect.DENY,
            actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream', 'bedrock:Converse', 'bedrock:ConverseStream'],
            resources: ['*'],
          }),
        ],
      });
      const roleNames = processingRoleNames(envName);
      const actionRole = new iam.Role(this, 'BudgetActionRole', {
        roleName: `QCMonster-${envName}-budget-action`,
        assumedBy: new iam.ServicePrincipal('budgets.amazonaws.com'),
      });
      actionRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['iam:AttachRolePolicy', 'iam:DetachRolePolicy'],
          resources: roleNames.map((r) => this.formatArn({ service: 'iam', region: '', resource: 'role', resourceName: r })),
          conditions: { ArnEquals: { 'iam:PolicyARN': denyBedrock.managedPolicyArn } },
        }),
      );

      // L'action cible les roles de L2a/L2b (crees plus tard): elle echouerait au deploiement tant qu'ils n'existent pas.
      // Activee par `-c budgetAction=true` une fois pipeline et verify deployes (docs/ops/bootstrap.md).
      if (this.node.tryGetContext('budgetAction') === 'true' || this.node.tryGetContext('budgetAction') === true) {
        new budgets.CfnBudgetsAction(this, 'SecurityAction', {
          budgetName: 'QCMonster-securite-40',
          notificationType: 'ACTUAL',
          actionType: 'APPLY_IAM_POLICY',
          actionThreshold: { type: 'PERCENTAGE', value: 100 },
          approvalModel: 'AUTOMATIC',
          executionRoleArn: actionRole.roleArn,
          definition: { iamActionDefinition: { policyArn: denyBedrock.managedPolicyArn, roles: roleNames } },
          subscribers: [{ type: 'EMAIL', address: alertEmail }],
        }).node.addDependency(this.node.findChild('securite-40'));
      }
    }

    // Alarme sur le compteur applicatif (publie par shared/cost.ts): e-mail des 10 EUR.
    const topic = new sns.Topic(this, 'CostAlerts', { topicName: `qcm-${envName}-cost-alerts` });
    topic.addSubscription(new subs.EmailSubscription(alertEmail));
    new cw.Alarm(this, 'CostCounter10', {
      alarmName: `qcm-${envName}-cout-mensuel-10`,
      alarmDescription: `Compteur de cout applicatif >= ${COST_ALERT_EUR} EUR ce mois-ci`,
      metric: new cw.Metric({
        namespace: METRIC_NAMESPACE,
        metricName: METRIC_COST_MONTH,
        dimensionsMap: { Env: envName },
        statistic: 'Maximum',
        period: Duration.hours(6),
      }),
      threshold: COST_ALERT_EUR,
      evaluationPeriods: 1,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cwActions.SnsAction(topic));
  }
}
