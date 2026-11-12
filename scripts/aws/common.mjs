import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { BudgetsClient, DescribeBudgetCommand, DescribeNotificationsForBudgetCommand, DescribeSubscribersForNotificationCommand } from '@aws-sdk/client-budgets';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';

export const region = process.env.AWS_REGION || 'us-east-1';
export const stackName = process.env.AWS_DEMO_STACK_NAME || 'PolicyDemo';
export const prefix = 'policy-demo-';
const readContexts = {
  GetCallerIdentity: ['STS', 'caller identity'],
  DescribeBudget: ['Budgets', 'budget'],
  DescribeNotificationsForBudget: ['Budgets', 'budget notifications'],
  DescribeSubscribersForNotification: ['Budgets', 'budget subscribers'],
  DescribeStacks: ['CloudFormation', 'stack inventory'],
  DescribeDBInstances: ['RDS', 'database instances'],
  DescribeDBSnapshots: ['RDS', 'database snapshots'],
  DescribeDBInstanceAutomatedBackups: ['RDS', 'automated backups'],
  DescribeDBSubnetGroups: ['RDS', 'database subnet groups'],
  DescribeVpcEndpoints: ['EC2', 'VPC endpoints'],
  DescribeVpcs: ['EC2', 'VPCs'],
  DescribeNetworkInterfaces: ['EC2', 'network interfaces'],
  ListFunctions: ['Lambda', 'functions'],
  ListEventSourceMappings: ['Lambda', 'event-source mappings'],
  GetApis: ['ApiGatewayV2', 'HTTP APIs'],
  ListSchedules: ['Scheduler', 'schedules'],
  DescribeAlarms: ['CloudWatch', 'alarms'],
  ListRoles: ['IAM', 'runtime roles'],
  ListQueues: ['SQS', 'queues'],
  DescribeLogGroups: ['CloudWatchLogs', 'log groups'],
  ListSecrets: ['SecretsManager', 'generated secrets'],
  ListObjectsV2: ['S3', 'asset objects'],
};
const errorCodes = new Set(['AccessDenied', 'AccessDeniedException', 'UnauthorizedOperation', 'ValidationError', 'ValidationException', 'ResourceNotFoundException', 'ResourceNotFound', 'NotFoundException', 'NoSuchEntity', 'NoSuchBucket', 'RequestTimeout', 'ThrottlingException', 'Throttling', 'TooManyRequestsException', 'ExpiredToken', 'ExpiredTokenException', 'InvalidClientTokenId', 'CredentialsProviderError', 'NetworkingError', 'TimeoutError', 'ServiceUnavailableException', 'InternalFailure', 'InternalServerError']);
// Keep only known API identifiers and error codes, never SDK messages or metadata.
export function safeReadError(command, error) {
  const candidate = command.constructor.name.replace(/Command$/, '');
  const action = Object.hasOwn(readContexts, candidate) ? candidate : 'UnknownRead';
  const [service, category] = readContexts[action] || ['AWS', 'unclassified inventory'];
  const code = errorCodes.has(error.name) ? error.name : 'UnknownAwsError';
  const safe = new Error(`AWS read failed: service=${service}; action=${action}; category=${category}; code=${code}.`);
  safe.name = 'SafeAwsReadError';
  return safe;
}
export async function awsRead(client, command) {
  try { return await client.send(command); } catch (error) { throw safeReadError(command, error); }
}
export function assertScope() {
  if (region !== 'us-east-1') throw new Error('This approved demo is restricted to us-east-1.');
  if (stackName !== 'PolicyDemo') throw new Error('Unexpected stack name; refusing to operate outside the demo.');
}
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function poll(label, read, done, { timeoutMs = 1_800_000, intervalMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (done(value)) return value;
    await sleep(intervalMs);
  }
  throw new Error(`${label} timed out; inspect the AWS console. Cleanup may still be required.`);
}
export const cfn = () => new CloudFormationClient({ region });
export async function readStack(name = stackName) {
  try { return (await cfn().send(new DescribeStacksCommand({ StackName: name }))).Stacks?.[0]; }
  catch (error) { if (error.name === 'ValidationError' && /does not exist/.test(error.message)) return undefined; throw safeReadError(new DescribeStacksCommand({}), error); }
}
export async function outputs() {
  assertScope();
  const stack = await readStack();
  if (!stack || !['CREATE_COMPLETE', 'UPDATE_COMPLETE'].includes(stack.StackStatus)) throw new Error('Demo stack is not ready.');
  return Object.fromEntries((stack.Outputs || []).map(x => [x.OutputKey, x.OutputValue]));
}
// Budget alerts are a warning, not a spend cap. Run before any deployment write.
export async function requireBudget() {
  assertScope();
  if (process.env.AWS_DEMO_APPROVED !== 'true') throw new Error('Set AWS_DEMO_APPROVED=true only after approving the documented resource inventory and disposable-demo costs.');
  const BudgetName = process.env.AWS_BUDGET_NAME;
  if (!BudgetName) throw new Error('AWS_BUDGET_NAME must identify the approved $5 monthly account budget.');
  const { Account: AccountId } = await awsRead(new STSClient({ region }), new GetCallerIdentityCommand({}));
  const budgets = new BudgetsClient({ region });
  const { Budget } = await awsRead(budgets, new DescribeBudgetCommand({ AccountId, BudgetName }));
  if (Budget?.BudgetType !== 'COST' || Budget.TimeUnit !== 'MONTHLY' || Budget.BudgetLimit?.Unit !== 'USD' || Number(Budget.BudgetLimit?.Amount) !== 5 || Object.keys(Budget.CostFilters || {}).length || Budget.FilterExpression)
    throw new Error('Expected an unfiltered, account-wide $5 USD MONTHLY COST budget.');
  const spend = Budget.CalculatedSpend?.ActualSpend;
  if (spend && (spend.Unit !== 'USD' || !Number.isFinite(Number(spend.Amount)) || Number(spend.Amount) >= 5)) throw new Error('Account budget is already exhausted or spend cannot be verified. Do not deploy.');
  const { Notifications = [] } = await awsRead(budgets, new DescribeNotificationsForBudgetCommand({ AccountId, BudgetName }));
  let notified = false;
  const diagnostics = [];
  const enumValue = (value, allowed) => value === undefined ? 'MISSING' : allowed.includes(value) ? value : 'UNKNOWN';
  for (const Notification of Notifications) {
    const amount = Notification.ThresholdType === 'PERCENTAGE' ? Number(Notification.Threshold) * 5 / 100 : Number(Notification.Threshold);
    const { Subscribers = [] } = await awsRead(budgets, new DescribeSubscribersForNotificationCommand({ AccountId, BudgetName, Notification }));
    diagnostics.push({
      notificationType: enumValue(Notification.NotificationType, ['ACTUAL', 'FORECASTED']),
      comparison: enumValue(Notification.ComparisonOperator, ['GREATER_THAN', 'LESS_THAN', 'EQUAL_TO']),
      thresholdType: enumValue(Notification.ThresholdType, ['PERCENTAGE', 'ABSOLUTE_VALUE']),
      threshold: Number.isFinite(Notification.Threshold) && Math.abs(Notification.Threshold) <= 100_000 ? Notification.Threshold : 'INVALID_OR_OUT_OF_RANGE',
      subscribers: { EMAIL: Subscribers.filter(x => x.SubscriptionType === 'EMAIL').length, SNS: Subscribers.filter(x => x.SubscriptionType === 'SNS').length, OTHER: Subscribers.filter(x => !['EMAIL', 'SNS'].includes(x.SubscriptionType)).length },
    });
    if (Number.isFinite(amount) && amount > 0 && amount <= 5 && Notification.NotificationType === 'ACTUAL' && Notification.ComparisonOperator === 'GREATER_THAN' && Subscribers.some(x => x.SubscriptionType === 'EMAIL' && x.Address)) notified = true;
  }
  if (!notified) throw new Error(`The budget needs an email alert at or below $5 before deployment. Notification summary (no addresses): ${JSON.stringify(diagnostics)}`);
  return AccountId;
}
export function reportError(error) {
  // SDK errors can contain account IDs, ARNs, URLs or request details. Keep public logs generic.
  console.error(`AWS demo operation failed (${String(error.name || 'Error').replace(/[^A-Za-z0-9_-]/g, '')}). ${error.$metadata ? 'Inspect AWS privately for service details.' : String(error.message).replace(/\b\d{12}\b/g, '[account]').replace(/arn:[^\s]+/g, '[arn]').replace(/https?:\/\/[^\s]+/g, '[url]')}`);
  process.exitCode = 1;
}
