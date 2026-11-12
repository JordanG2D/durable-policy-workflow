import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { BudgetsClient, DescribeBudgetCommand, DescribeNotificationsForBudgetCommand, DescribeSubscribersForNotificationCommand } from '@aws-sdk/client-budgets';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';

export const region = process.env.AWS_REGION || 'us-east-1';
export const stackName = process.env.AWS_DEMO_STACK_NAME || 'PolicyDemo';
export const prefix = 'policy-demo-';
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
  catch (error) { if (error.name === 'ValidationError' && /does not exist/.test(error.message)) return undefined; throw error; }
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
  const { Account: AccountId } = await new STSClient({ region }).send(new GetCallerIdentityCommand({}));
  const budgets = new BudgetsClient({ region });
  const { Budget } = await budgets.send(new DescribeBudgetCommand({ AccountId, BudgetName }));
  if (Budget?.BudgetType !== 'COST' || Budget.TimeUnit !== 'MONTHLY' || Budget.BudgetLimit?.Unit !== 'USD' || Number(Budget.BudgetLimit?.Amount) !== 5 || Object.keys(Budget.CostFilters || {}).length || Budget.FilterExpression)
    throw new Error('Expected an unfiltered, account-wide $5 USD MONTHLY COST budget.');
  const spend = Budget.CalculatedSpend?.ActualSpend;
  if (spend && (spend.Unit !== 'USD' || !Number.isFinite(Number(spend.Amount)) || Number(spend.Amount) >= 5)) throw new Error('Account budget is already exhausted or spend cannot be verified. Do not deploy.');
  const { Notifications = [] } = await budgets.send(new DescribeNotificationsForBudgetCommand({ AccountId, BudgetName }));
  let notified = false;
  for (const Notification of Notifications) {
    const amount = Notification.ThresholdType === 'PERCENTAGE' ? Number(Notification.Threshold) * 5 / 100 : Number(Notification.Threshold);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 5 || Notification.NotificationType !== 'ACTUAL' || Notification.ComparisonOperator !== 'GREATER_THAN') continue;
    const { Subscribers = [] } = await budgets.send(new DescribeSubscribersForNotificationCommand({ AccountId, BudgetName, Notification }));
    if (Subscribers.some(x => x.SubscriptionType === 'EMAIL' && x.Address)) notified = true;
  }
  if (!notified) throw new Error('The budget needs an email alert at or below $5 before deployment.');
  return AccountId;
}
export function reportError(error) {
  // SDK errors can contain account IDs, ARNs, URLs or request details. Keep public logs generic.
  console.error(`AWS demo operation failed (${String(error.name || 'Error').replace(/[^A-Za-z0-9_-]/g, '')}). ${error.$metadata ? 'Inspect AWS privately for service details.' : String(error.message).replace(/\b\d{12}\b/g, '[account]').replace(/arn:[^\s]+/g, '[arn]').replace(/https?:\/\/[^\s]+/g, '[url]')}`);
  process.exitCode = 1;
}
