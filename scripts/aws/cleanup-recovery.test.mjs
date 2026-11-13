import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { RDSClient } from '@aws-sdk/client-rds';
import { EC2Client } from '@aws-sdk/client-ec2';
import { ApiGatewayV2Client } from '@aws-sdk/client-apigatewayv2';
import { SchedulerClient } from '@aws-sdk/client-scheduler';
import { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import { IAMClient } from '@aws-sdk/client-iam';
import { SQSClient } from '@aws-sdk/client-sqs';
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { S3Client } from '@aws-sdk/client-s3';
import { deleteRuntimeStack } from './cleanup-recovery.mjs';
import { destroy } from './operate.mjs';

const uuid = '00000000-0000-4000-8000-000000000001'; // Synthetic test identity only.
const record = { LogicalResourceId: 'WorkerMessages', ResourceType: 'AWS::Lambda::EventSourceMapping', ResourceStatus: 'DELETE_FAILED', PhysicalResourceId: uuid };
function fixture(t, options = {}) {
  let state = options.initialStatus || 'DELETE_FAILED';
  let resourcePage = 0;
  let mappingPage = 0;
  let runtimeReads = 0;
  let inventoried = false;
  const calls = [];
  const writes = [];
  const logs = [];
  const stack = { StackName: 'PolicyDemo', StackId: 'synthetic-stack-identity', Tags: [{ Key: 'Project', Value: 'PolicyDemo' }], ...options.stack };
  t.mock.method(console, 'log', value => logs.push(value));
  t.mock.method(CloudFormationClient.prototype, 'send', async command => {
    const name = command.constructor.name;
    calls.push({ name, input: command.input });
    if (options.denied === name) throw Object.assign(new Error('private-account-details'), { name: 'AccessDeniedException' });
    if (name === 'DescribeStacksCommand') {
      if (command.input.StackName === 'PolicyDemoBootstrap') return { Stacks: [{
        Tags: [{ Key: 'Project', Value: 'PolicyDemo' }],
        Outputs: [{ OutputKey: 'AssetBucketName', OutputValue: 'synthetic-assets' }, { OutputKey: 'CloudFormationExecutionRoleArn', OutputValue: 'synthetic-role' }, { OutputKey: 'RuntimeBoundaryArn', OutputValue: 'synthetic-boundary' }],
      }] };
      if (options.pendingOutcome && runtimeReads++ > 0 && /_IN_PROGRESS$/.test(state)) state = options.pendingOutcome;
      if (state === 'DELETE_COMPLETE' && command.input.StackName === 'PolicyDemo') return { Stacks: [] };
      return { Stacks: [{ ...stack, StackStatus: state, ...(inventoried ? options.recheck : {}) }] };
    }
    if (name === 'ListStackResourcesCommand') return (options.resourcePages || [{ StackResourceSummaries: [record] }])[resourcePage++];
    if (name === 'DeleteStackCommand') {
      writes.push(command.input);
      state = command.input.RetainResources ? (options.retryFails ? 'DELETE_FAILED' : 'DELETE_COMPLETE') : (options.normalSucceeds ? 'DELETE_COMPLETE' : 'DELETE_FAILED');
      return {};
    }
    assert.fail('Unexpected CloudFormation action');
  });
  t.mock.method(LambdaClient.prototype, 'send', async command => {
    const name = command.constructor.name;
    calls.push({ name, input: command.input });
    if (options.denied === name) throw Object.assign(new Error('private-mapping-details'), { name: 'AccessDeniedException' });
    if (name === 'ListFunctionsCommand') return { Functions: [] };
    assert.equal(name, 'ListEventSourceMappingsCommand');
    const response = (options.mappingPages || [{ EventSourceMappings: [] }])[mappingPage++] || { EventSourceMappings: [] };
    inventoried = true;
    return response;
  });
  return { calls, writes, logs };
}
test('initial DELETE_FAILED retains only absent stale WorkerMessages record', async t => {
  const { writes, logs } = fixture(t);
  await deleteRuntimeStack('synthetic-role');
  assert.deepEqual(writes, [{ StackName: 'synthetic-stack-identity', RoleARN: 'synthetic-role', RetainResources: ['WorkerMessages'] }]);
  assert.ok(logs.every(value => !value.includes(uuid) && !value.includes('synthetic-stack-identity')));
});
test('fresh delete failure performs only one guarded retry', async t => {
  const { writes } = fixture(t, { initialStatus: 'CREATE_COMPLETE' });
  await deleteRuntimeStack('synthetic-role');
  assert.equal(writes.length, 2);
  assert.equal(writes[0].RetainResources, undefined);
  assert.deepEqual(writes[1].RetainResources, ['WorkerMessages']);
});
test('normal successful deletion never reads recovery inventories or retains anything', async t => {
  const { writes, calls } = fixture(t, { initialStatus: 'CREATE_COMPLETE', normalSucceeds: true });
  await deleteRuntimeStack('synthetic-role');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].RetainResources, undefined);
  assert.ok(!calls.some(x => x.name === 'ListStackResourcesCommand'));
});
test('initial deletion in progress completes without issuing another delete', async t => {
  const { writes, calls } = fixture(t, { initialStatus: 'DELETE_IN_PROGRESS', pendingOutcome: 'DELETE_COMPLETE' });
  await deleteRuntimeStack('synthetic-role');
  assert.deepEqual(writes, []);
  assert.equal(calls.filter(x => x.name === 'DescribeStacksCommand').length, 2);
  assert.ok(!calls.some(x => x.name === 'ListStackResourcesCommand'));
});
test('initial deletion in progress fails then performs one guarded recovery', async t => {
  const { writes, calls } = fixture(t, { initialStatus: 'DELETE_IN_PROGRESS', pendingOutcome: 'DELETE_FAILED' });
  await deleteRuntimeStack('synthetic-role');
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].RetainResources, ['WorkerMessages']);
  assert.equal(calls.filter(x => x.name === 'ListEventSourceMappingsCommand').length, 1);
});
test('failed guarded retry cannot issue another delete', async t => {
  const { writes } = fixture(t, { retryFails: true });
  await assert.rejects(() => deleteRuntimeStack('synthetic-role'), /single guarded retry/);
  assert.equal(writes.length, 1);
});
for (const [name, options] of [
  ['existing exact mapping', { mappingPages: [{ EventSourceMappings: [{ UUID: uuid }] }] }],
  ['wrong project tag', { stack: { Tags: [{ Key: 'Project', Value: 'Other' }] } }],
  ['wrong stack name', { stack: { StackName: 'Other' } }],
  ['wrong resource type', { resourcePages: [{ StackResourceSummaries: [{ ...record, ResourceType: 'AWS::Lambda::Function' }] }] }],
  ['wrong logical ID', { resourcePages: [{ StackResourceSummaries: [{ ...record, LogicalResourceId: 'Other' }] }] }],
  ['wrong resource status', { resourcePages: [{ StackResourceSummaries: [{ ...record, ResourceStatus: 'DELETE_COMPLETE' }] }] }],
  ['missing physical UUID', { resourcePages: [{ StackResourceSummaries: [{ ...record, PhysicalResourceId: undefined }] }] }],
  ['duplicate logical ID', { resourcePages: [{ StackResourceSummaries: [record, record] }] }],
  ['other failed resource', { resourcePages: [{ StackResourceSummaries: [record, { ...record, LogicalResourceId: 'Other' }] }] }],
  ['incomplete mapping inventory', { mappingPages: [{}] }],
  ['malformed mapping record', { mappingPages: [{ EventSourceMappings: [{}] }] }],
  ['incomplete stack inventory', { resourcePages: [{}] }],
  ['changed stack identity', { recheck: { StackId: 'different-stack' } }],
  ['changed stack ownership', { recheck: { Tags: [] } }],
  ['repeated pagination marker', { mappingPages: [{ EventSourceMappings: [], NextMarker: 'same' }, { EventSourceMappings: [], NextMarker: 'same' }] }],
  ['invalid pagination token', { mappingPages: [{ EventSourceMappings: [], NextMarker: null }] }],
  ['stack inventory denied', { denied: 'ListStackResourcesCommand' }],
  ['mapping inventory denied', { denied: 'ListEventSourceMappingsCommand' }],
]) test(`refuses ${name} without any deletion write`, async t => {
  const { writes } = fixture(t, options);
  await assert.rejects(() => deleteRuntimeStack('synthetic-role'));
  assert.deepEqual(writes, []);
});
test('fully paginates both inventories with no Lambda filter before absent recovery', async t => {
  const { calls, writes } = fixture(t, {
    resourcePages: [{ StackResourceSummaries: [], NextToken: 'next-resource-page' }, { StackResourceSummaries: [record] }],
    mappingPages: [{ EventSourceMappings: [], NextMarker: 'next-mapping-page' }, { EventSourceMappings: [] }],
  });
  await deleteRuntimeStack('synthetic-role');
  assert.deepEqual(calls.filter(x => x.name === 'ListEventSourceMappingsCommand').map(x => x.input), [{}, { Marker: 'next-mapping-page' }]);
  assert.equal(calls.filter(x => x.name === 'ListStackResourcesCommand')[1].input.NextToken, 'next-resource-page');
  assert.equal(writes.length, 1);
});
test('exact UUID on a later Lambda page blocks recovery', async t => {
  const { writes } = fixture(t, { mappingPages: [{ EventSourceMappings: [], NextMarker: 'next' }, { EventSourceMappings: [{ UUID: uuid }] }] });
  await assert.rejects(() => deleteRuntimeStack('synthetic-role'), /still exists/);
  assert.deepEqual(writes, []);
});
for (const inventoryFails of [false, true]) test(`destroy still requires final full inventory: ${inventoryFails ? 'denied read fails' : 'empty reads pass'}`, async t => {
  const { writes, logs, calls } = fixture(t);
  const reads = [];
  for (const Client of [RDSClient, EC2Client, ApiGatewayV2Client, SchedulerClient, CloudWatchClient, IAMClient, SQSClient, CloudWatchLogsClient, SecretsManagerClient, S3Client]) {
    t.mock.method(Client.prototype, 'send', async command => {
      const name = command.constructor.name;
      reads.push(name);
      assert.match(name, /^(Describe|List|Get)/);
      if (inventoryFails && name === 'ListSecretsCommand') throw Object.assign(new Error('private'), { name: 'AccessDeniedException' });
      return {};
    });
  }
  for (const key of ['POLICY_ASSET_BUCKET', 'AWS_ASSET_BUCKET', 'POLICY_RUNTIME_BOUNDARY_ARN']) {
    const previous = process.env[key];
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  if (inventoryFails) await assert.rejects(destroy, /service=SecretsManager; action=ListSecrets/);
  else await destroy();
  assert.equal(writes.length, 1);
  assert.ok(reads.includes('DescribeDBInstanceAutomatedBackupsCommand'));
  assert.ok(reads.includes('ListSecretsCommand'));
  assert.ok(calls.filter(x => x.name === 'ListEventSourceMappingsCommand').length >= 2);
  assert.equal(logs.some(value => value.startsWith('Runtime cleanup verified:')), !inventoryFails);
});
