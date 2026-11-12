import test from 'node:test';
import assert from 'node:assert/strict';
import { STSClient } from '@aws-sdk/client-sts';
import { BudgetsClient } from '@aws-sdk/client-budgets';
import { CloudWatchClient, DescribeAlarmsCommand } from '@aws-sdk/client-cloudwatch';
import { requireBudget, poll, awsRead, safeReadError } from './common.mjs';

function fixture(t, { budget = {}, notification = {}, subscribers = [{ SubscriptionType: 'EMAIL', Address: 'test@example.invalid' }] } = {}) {
  const oldApproval = process.env.AWS_DEMO_APPROVED;
  const oldBudget = process.env.AWS_BUDGET_NAME;
  process.env.AWS_DEMO_APPROVED = 'true';
  process.env.AWS_BUDGET_NAME = 'portfolio-demo-budget';
  t.after(() => {
    if (oldApproval === undefined) delete process.env.AWS_DEMO_APPROVED; else process.env.AWS_DEMO_APPROVED = oldApproval;
    if (oldBudget === undefined) delete process.env.AWS_BUDGET_NAME; else process.env.AWS_BUDGET_NAME = oldBudget;
  });
  t.mock.method(STSClient.prototype, 'send', async () => ({ Account: 'offline-test-account' }));
  t.mock.method(BudgetsClient.prototype, 'send', async command => {
    switch (command.constructor.name) {
      case 'DescribeBudgetCommand': return { Budget: { BudgetType: 'COST', TimeUnit: 'MONTHLY', BudgetLimit: { Amount: '5', Unit: 'USD' }, ...budget } };
      case 'DescribeNotificationsForBudgetCommand': return { Notifications: [{ NotificationType: 'ACTUAL', ThresholdType: 'PERCENTAGE', Threshold: 100, ComparisonOperator: 'GREATER_THAN', ...notification }] };
      case 'DescribeSubscribersForNotificationCommand': return { Subscribers: subscribers };
      default: throw new Error('Unexpected AWS command in offline test.');
    }
  });
}
test('approved account-wide $5 budget with actual email alert passes', async t => {
  fixture(t);
  assert.equal(await requireBudget(), 'offline-test-account');
});
test('approval missing fails before AWS access', async t => {
  fixture(t);
  delete process.env.AWS_DEMO_APPROVED;
  t.mock.method(STSClient.prototype, 'send', async () => { assert.fail('AWS must not be called'); });
  await assert.rejects(requireBudget, /AWS_DEMO_APPROVED/);
});
for (const [name, options] of [
  ['forecast-only alert', { notification: { NotificationType: 'FORECASTED' } }],
  ['invalid threshold', { notification: { Threshold: 'NaN' } }],
  ['zero threshold', { notification: { Threshold: 0 } }],
  ['too-late alert', { notification: { Threshold: 101 } }],
  ['absolute alert over $5', { notification: { ThresholdType: 'ABSOLUTE_VALUE', Threshold: 5.01 } }],
  ['old $10 budget', { budget: { BudgetLimit: { Amount: '10', Unit: 'USD' } } }],
  ['no email subscriber', { subscribers: [] }],
  ['filtered budget', { budget: { CostFilters: { Service: ['Amazon RDS'] } } }],
  ['exhausted budget', { budget: { CalculatedSpend: { ActualSpend: { Amount: '5', Unit: 'USD' } } } }],
]) test(`rejects ${name}`, async t => { fixture(t, options); await assert.rejects(requireBudget); });
test('poll returns ready value and bounds unfinished work', async () => {
  assert.equal(await poll('ready', async () => 3, x => x === 3, { timeoutMs: 50, intervalMs: 1 }), 3);
  await assert.rejects(() => poll('never ready', async () => false, Boolean, { timeoutMs: 5, intervalMs: 1 }), /timed out/);
});
test('budget failure diagnoses enum fields and subscriber counts without addresses', async t => {
  fixture(t, { notification: { Threshold: 101 }, subscribers: [{ SubscriptionType: 'EMAIL', Address: 'private@example.invalid' }, { SubscriptionType: 'SNS', Address: 'arn:aws:sns:private-topic' }] });
  await assert.rejects(requireBudget, error => {
    assert.match(error.message, /"threshold":101/);
    assert.match(error.message, /"EMAIL":1,"SNS":1,"OTHER":0/);
    assert.doesNotMatch(error.message, /private@example|arn:aws/);
    return true;
  });
});
test('budget diagnostics replace unexpected fields instead of printing arbitrary data', async t => {
  fixture(t, { notification: { ThresholdType: 'private-value', NotificationType: 'private-value', ComparisonOperator: 'private-value', Threshold: 'private-value' }, subscribers: [{ SubscriptionType: 'private-value', Address: 'private-value' }] });
  await assert.rejects(requireBudget, error => {
    assert.match(error.message, /UNKNOWN/);
    assert.match(error.message, /"OTHER":1/);
    assert.doesNotMatch(error.message, /private-value/);
    return true;
  });
});
test('AWS read failures retain safe service/action/category/code only', async t => {
  t.mock.method(CloudWatchClient.prototype, 'send', async () => {
    throw Object.assign(new Error('private@example.invalid arn:aws:private https://private.invalid secret-token'), { name: 'AccessDeniedException', $metadata: { requestId: 'private-request-id' } });
  });
  await assert.rejects(() => awsRead(new CloudWatchClient({ region: 'us-east-1' }), new DescribeAlarmsCommand({})), error => {
    assert.equal(error.name, 'SafeAwsReadError');
    assert.equal(error.message, 'AWS read failed: service=CloudWatch; action=DescribeAlarms; category=alarms; code=AccessDeniedException.');
    assert.equal(error.$metadata, undefined);
    assert.equal(error.cause, undefined);
    return true;
  });
});
test('unknown SDK error names are not printed', () => {
  const error = safeReadError(new DescribeAlarmsCommand({}), { name: 'secretValue', message: 'private' });
  assert.match(error.message, /code=UnknownAwsError/);
  assert.doesNotMatch(error.message, /secretValue|private/);
});
