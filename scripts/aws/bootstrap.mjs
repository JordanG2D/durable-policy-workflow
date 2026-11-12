import { URL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { CloudFormationClient, CreateStackCommand, DescribeStacksCommand, waitUntilStackCreateComplete } from '@aws-sdk/client-cloudformation';
import { BudgetsClient, DescribeBudgetCommand, DescribeNotificationsForBudgetCommand, DescribeSubscribersForNotificationCommand } from '@aws-sdk/client-budgets';
import { IAMClient, ListOpenIDConnectProvidersCommand, GetOpenIDConnectProviderCommand } from '@aws-sdk/client-iam';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { template } from '../../infra/bootstrap/template.mjs';

const region = 'us-east-1';
const budgetName = process.env.AWS_BUDGET_NAME ?? 'portfolio-demo-budget';
const directory = new URL('../../infra/.state/', import.meta.url);
await mkdir(directory, { recursive: true, mode: 0o700 });
await writeFile(new URL('bootstrap-template.json', directory), JSON.stringify(template, null, 2), { mode: 0o600 });
if (!process.argv.includes('--apply')) {
  console.log('Prepared reviewable bootstrap template. No AWS calls made.');
  console.log('Creates a private S3 asset bucket, GitHub OIDC provider (only if missing), repository/main-only role, CloudFormation execution role, and runtime permission boundary.');
  console.log('Review infra/bootstrap/template.mjs and README. Applying requires explicit approval for persistent AWS access plus a verified $5 budget alert.');
  process.exit(0);
}
if (process.env.AWS_BOOTSTRAP_APPROVED !== 'true') throw new Error('Persistent-access approval required: set AWS_BOOTSTRAP_APPROVED=true only after reviewing and approving this exact bootstrap.');
if (process.env.AWS_REGION && process.env.AWS_REGION !== region) throw new Error('Only us-east-1 is authorized.');
const identity = await new STSClient({ region }).send(new GetCallerIdentityCommand({}));
if (!identity.Account) throw new Error('Unable to identify AWS account.');
const budgets = new BudgetsClient({ region });
const { Budget } = await budgets.send(new DescribeBudgetCommand({ AccountId: identity.Account, BudgetName: budgetName }));
if (Budget?.BudgetType !== 'COST' || Budget.TimeUnit !== 'MONTHLY' || Number(Budget.BudgetLimit?.Amount) !== 5 || Budget.BudgetLimit?.Unit !== 'USD' || Object.keys(Budget.CostFilters ?? {}).length || Budget.FilterExpression) {
  throw new Error('Create and verify the $5 USD monthly cost budget first.');
}
const notices = await budgets.send(new DescribeNotificationsForBudgetCommand({ AccountId: identity.Account, BudgetName: budgetName }));
let hasEmail = false;
for (const notification of notices.Notifications ?? []) {
  const threshold = notification.ThresholdType === 'PERCENTAGE' ? Number(notification.Threshold) / 100 * 5 : Number(notification.Threshold);
  if (notification.NotificationType !== 'ACTUAL' || notification.ComparisonOperator !== 'GREATER_THAN' || !Number.isFinite(threshold) || threshold > 5 || threshold <= 0) continue;
  const result = await budgets.send(new DescribeSubscribersForNotificationCommand({ AccountId: identity.Account, BudgetName: budgetName, Notification: notification }));
  hasEmail ||= (result.Subscribers ?? []).some((subscriber) => subscriber.SubscriptionType === 'EMAIL');
}
if (!hasEmail) throw new Error('The $5 budget needs an actual-spend email alert at or before $5.');
const cfn = new CloudFormationClient({ region });
try {
  await cfn.send(new DescribeStacksCommand({ StackName: 'PolicyDemoBootstrap' }));
  throw new Error('Bootstrap already exists. Refusing an implicit IAM update; inspect the existing stack before proceeding.');
} catch (error) {
  if (error.name !== 'ValidationError' || !String(error.message).includes('does not exist')) throw error;
}
const iam = new IAMClient({ region });
const providers = await iam.send(new ListOpenIDConnectProvidersCommand({}));
let existingProvider = '';
for (const entry of providers.OpenIDConnectProviderList ?? []) {
  const provider = await iam.send(new GetOpenIDConnectProviderCommand({ OpenIDConnectProviderArn: entry.Arn }));
  if (provider.Url === 'token.actions.githubusercontent.com' || provider.Url === 'https://token.actions.githubusercontent.com') {
    if (!provider.ClientIDList?.includes('sts.amazonaws.com')) throw new Error('Existing GitHub provider lacks AWS audience; modifying persistent access requires separate approval.');
    existingProvider = entry.Arn;
  }
}
await cfn.send(new CreateStackCommand({ StackName: 'PolicyDemoBootstrap', TemplateBody: JSON.stringify(template), Capabilities: ['CAPABILITY_NAMED_IAM'],
  Parameters: [ { ParameterKey: 'ExistingOidcProviderArn', ParameterValue: existingProvider }, { ParameterKey: 'BudgetName', ParameterValue: budgetName } ],
  Tags: [{ Key: 'Project', Value: 'PolicyDemo' }], OnFailure: 'ROLLBACK',
}));
await waitUntilStackCreateComplete({ client: cfn, maxWaitTime: 1200 }, { StackName: 'PolicyDemoBootstrap' });
const result = await cfn.send(new DescribeStacksCommand({ StackName: 'PolicyDemoBootstrap' }));
const outputs = Object.fromEntries((result.Stacks?.[0]?.Outputs ?? []).map(({ OutputKey, OutputValue }) => [OutputKey, OutputValue]));
await writeFile(new URL('bootstrap-outputs.json', directory), JSON.stringify(outputs, null, 2), { mode: 0o600 });
console.log('GitHub OIDC bootstrap created. Account-specific outputs were saved only to ignored private local state. No keys were saved.');
console.log('Set the GitHub POLICY_DEMO_ROLE_ARN variable from GithubRoleArn, then verify a manual OIDC workflow before deleting the temporary bootstrap user.');
