import test from 'node:test';
import assert from 'node:assert/strict';
import { STSClient } from '@aws-sdk/client-sts';
import { BudgetsClient } from '@aws-sdk/client-budgets';
import { CloudWatchClient, DescribeAlarmsCommand } from '@aws-sdk/client-cloudwatch';
import { requireBudget, poll, awsRead, safeReadError, notificationThresholdUsd } from './common.mjs';
import { prepareDeployment } from './operate.mjs';
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { RDSClient } from '@aws-sdk/client-rds';
import { EC2Client } from '@aws-sdk/client-ec2';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { ApiGatewayV2Client } from '@aws-sdk/client-apigatewayv2';
import { SchedulerClient } from '@aws-sdk/client-scheduler';
import { IAMClient } from '@aws-sdk/client-iam';
import { SQSClient } from '@aws-sdk/client-sqs';
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { S3Client } from '@aws-sdk/client-s3';
import demoAlarmNames from './alarm-names.json' with { type: 'json' };

function fixture(t, { budget = {}, notification = {}, notifications, subscribers = [{ SubscriptionType: 'EMAIL', Address: 'test@example.invalid' }] } = {}) {
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
      case 'DescribeNotificationsForBudgetCommand': return { Notifications: (notifications || [notification]).map(value => ({ NotificationType: 'ACTUAL', ThresholdType: 'PERCENTAGE', Threshold: 100, ComparisonOperator: 'GREATER_THAN', ...value })) };
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
  ['omitted-type alert over 100 percent', { notification: { ThresholdType: undefined, Threshold: 101 } }],
  ['unknown explicit threshold type', { notification: { ThresholdType: 'UNKNOWN', Threshold: 4 } }],
  ['null threshold type', { notification: { ThresholdType: null, Threshold: 4 } }],
  ['NaN threshold', { notification: { Threshold: Number.NaN } }],
  ['infinite threshold', { notification: { Threshold: Number.POSITIVE_INFINITY } }],
  ['numeric string threshold', { notification: { Threshold: '4' } }],
  ['missing threshold', { notification: { Threshold: undefined } }],
  ['absolute alert over $5', { notification: { ThresholdType: 'ABSOLUTE_VALUE', Threshold: 5.01 } }],
  ['old $10 budget', { budget: { BudgetLimit: { Amount: '10', Unit: 'USD' } } }],
  ['no email subscriber', { subscribers: [] }],
  ['filtered budget', { budget: { CostFilters: { Service: ['Amazon RDS'] } } }],
  ['exhausted budget', { budget: { CalculatedSpend: { ActualSpend: { Amount: '5', Unit: 'USD' } } } }],
]) test(`rejects ${name}`, async t => { fixture(t, options); await assert.rejects(requireBudget); });
test('omitted threshold type requires exact verified compatibility context', () => {
  const notice = { NotificationType: 'ACTUAL', ComparisonOperator: 'GREATER_THAN' };
  const context = { verifiedLegacyBudgetName: 'portfolio-demo-budget' };
  assert.equal(notificationThresholdUsd({ ...notice, Threshold: 50 }, context), 2.5);
  assert.equal(notificationThresholdUsd({ ...notice, Threshold: 80 }, context), 4);
  assert.equal(notificationThresholdUsd({ ...notice, Threshold: 100 }, context), 5);
  assert.ok(Number.isNaN(notificationThresholdUsd({ ...notice, Threshold: 80 })));
  assert.ok(Number.isNaN(notificationThresholdUsd({ ...notice, Threshold: 80 }, { verifiedLegacyBudgetName: 'another-budget' })));
  assert.ok(Number.isNaN(notificationThresholdUsd({ ...notice, Threshold: 4 }, context)));
  assert.ok(Number.isNaN(notificationThresholdUsd({ ...notice, NotificationType: 'FORECASTED', Threshold: 80 }, context)));
  assert.ok(Number.isNaN(notificationThresholdUsd({ ...notice, ComparisonOperator: 'LESS_THAN', Threshold: 80 }, context)));
  assert.equal(notificationThresholdUsd({ ThresholdType: 'PERCENTAGE', Threshold: 80 }), 4);
  assert.equal(notificationThresholdUsd({ ThresholdType: 'ABSOLUTE_VALUE', Threshold: 4 }), 4);
  assert.equal(notificationThresholdUsd({ ThresholdType: 'ABSOLUTE_VALUE', Threshold: 100 }), 100);
});
test('other budgets cannot use omitted-type compatibility mapping', async t => {
  fixture(t, { notification: { ThresholdType: undefined, Threshold: 80 } });
  process.env.AWS_BUDGET_NAME = 'another-budget';
  await assert.rejects(requireBudget);
});
test('unverified omitted threshold fails even for the approved budget', async t => {
  fixture(t, { notification: { ThresholdType: undefined, Threshold: 4 } });
  await assert.rejects(requireBudget);
});
test('observed three omitted-type notifications pass without changing subscriber queries', async t => {
  fixture(t, { notifications: [100, 50, 80].map(Threshold => ({ Threshold, ThresholdType: undefined })) });
  assert.equal(await requireBudget(), 'offline-test-account');
  const calls = BudgetsClient.prototype.send.mock.calls.filter(call => call.arguments[0].constructor.name === 'DescribeSubscribersForNotificationCommand');
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.arguments[0].input.Notification.ThresholdType === undefined));
});
for (const Threshold of [2.5, 4, 5]) test(`explicit absolute $${Threshold} alert passes`, async t => {
  fixture(t, { notification: { ThresholdType: 'ABSOLUTE_VALUE', Threshold } });
  assert.equal(await requireBudget(), 'offline-test-account');
});
test('mixed notifications require at least one qualifying actual email alert', async t => {
  fixture(t, { notifications: [{ ThresholdType: 'UNKNOWN', Threshold: 4 }, { NotificationType: 'FORECASTED' }, { ThresholdType: undefined, Threshold: 80 }] });
  assert.equal(await requireBudget(), 'offline-test-account');
});
test('multiple nonqualifying notifications cannot collectively satisfy the guard', async t => {
  fixture(t, { notifications: [{ ThresholdType: 'UNKNOWN', Threshold: 4 }, { NotificationType: 'FORECASTED', ThresholdType: undefined }, { ThresholdType: 'ABSOLUTE_VALUE', Threshold: 100 }] });
  await assert.rejects(requireBudget);
});
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
function inventoryFixture(t, { deniedAction, prior, alarms = [] } = {}) {
  fixture(t);
  const calls = [];
  for (const key of ['POLICY_ASSET_BUCKET', 'AWS_ASSET_BUCKET', 'POLICY_RUNTIME_BOUNDARY_ARN']) {
    const original = process.env[key];
    t.after(() => { if (original === undefined) delete process.env[key]; else process.env[key] = original; });
  }
  const clients = [CloudFormationClient, RDSClient, EC2Client, LambdaClient, ApiGatewayV2Client, SchedulerClient, CloudWatchClient, IAMClient, SQSClient, CloudWatchLogsClient, SecretsManagerClient, S3Client];
  for (const Client of clients) t.mock.method(Client.prototype, 'send', async command => {
    const action = command.constructor.name;
    calls.push(action);
    assert.match(action, /^(Describe|List|Get)/, 'preflight must never call a write API');
    if (action === deniedAction) throw Object.assign(new Error('private detail'), { name: 'AccessDeniedException' });
    if (action === 'DescribeStacksCommand') return { Stacks: command.input.StackName === 'PolicyDemoBootstrap' ? [{
      Tags: [{ Key: 'Project', Value: 'PolicyDemo' }],
      Outputs: [{ OutputKey: 'AssetBucketName', OutputValue: 'test-bucket' }, { OutputKey: 'CloudFormationExecutionRoleArn', OutputValue: 'test-role' }, { OutputKey: 'RuntimeBoundaryArn', OutputValue: 'test-boundary' }],
    }] : prior ? [prior] : [] };
    if (action === 'DescribeAlarmsCommand') {
      assert.deepEqual(command.input, { AlarmNames: demoAlarmNames, AlarmTypes: ['MetricAlarm'] });
      return { MetricAlarms: alarms };
    }
    return {};
  });
  return calls;
}
test('deployment preflight fails on alarm read denial before any writes', async t => {
  const calls = inventoryFixture(t, { deniedAction: 'DescribeAlarmsCommand' });
  await assert.rejects(prepareDeployment, /service=CloudWatch; action=DescribeAlarms; category=alarms; code=AccessDeniedException/);
  assert.ok(!calls.includes('ListRolesCommand'));
});
test('deployment preflight also fails closed on a later inventory denial', async t => {
  inventoryFixture(t, { deniedAction: 'ListSecretsCommand' });
  await assert.rejects(prepareDeployment, /service=SecretsManager; action=ListSecrets/);
});
test('deployment preflight reads through bucket inventory and permits existing stack updates', async t => {
  const prior = { StackStatus: 'UPDATE_COMPLETE', Tags: [{ Key: 'Project', Value: 'PolicyDemo' }] };
  const calls = inventoryFixture(t, { prior, alarms: [{ AlarmName: demoAlarmNames[0] }] });
  assert.equal((await prepareDeployment()).prior, prior);
  assert.equal(calls.at(-1), 'ListObjectsV2Command');
  assert.ok(calls.includes('DescribeNetworkInterfacesCommand'));
});
test('deployment preflight rejects orphaned demo alarms without a runtime stack', async t => {
  inventoryFixture(t, { alarms: [{ AlarmName: demoAlarmNames[0] }] });
  await assert.rejects(prepareDeployment, /remain without a runtime stack: CloudWatch alarm/);
});
test('deployment budget failure precedes all cleanup inventory reads', async t => {
  const calls = inventoryFixture(t);
  delete process.env.AWS_DEMO_APPROVED;
  await assert.rejects(prepareDeployment, /AWS_DEMO_APPROVED/);
  assert.deepEqual(calls, []);
});
