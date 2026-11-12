import { Stack, CfnParameter, aws_budgets as budgets, type StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
/** Separate lifecycle: keep during demo cleanup; remove only on total teardown. */
export class BudgetStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    const email = new CfnParameter(this, 'AlertEmail', { type: 'String', description: 'Owner email for budget alerts', allowedPattern: '[^@\\s]+@[^@\\s]+\\.[^@\\s]+' });
    new budgets.CfnBudget(this, 'MonthlyBudget', { budget: { budgetName: 'portfolio-demo-budget', budgetType: 'COST', timeUnit: 'MONTHLY', budgetLimit: { amount: 5, unit: 'USD' } }, notificationsWithSubscribers: [50, 80, 100].map(threshold => ({ notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold, thresholdType: 'PERCENTAGE' }, subscribers: [{ subscriptionType: 'EMAIL', address: email.valueAsString }] })) });
  }
}
