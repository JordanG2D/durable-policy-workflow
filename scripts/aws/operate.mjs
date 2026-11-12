import { execFileSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CreateChangeSetCommand, DescribeChangeSetCommand, ExecuteChangeSetCommand, DeleteChangeSetCommand, DeleteStackCommand } from '@aws-sdk/client-cloudformation';
import { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { LambdaClient, InvokeCommand, ListFunctionsCommand, ListEventSourceMappingsCommand } from '@aws-sdk/client-lambda';
import { RDSClient, DescribeDBInstancesCommand, DescribeDBSnapshotsCommand, DescribeDBInstanceAutomatedBackupsCommand, DescribeDBSubnetGroupsCommand } from '@aws-sdk/client-rds';
import { EC2Client, DescribeVpcEndpointsCommand, DescribeVpcsCommand, DescribeNetworkInterfacesCommand } from '@aws-sdk/client-ec2';
import { SecretsManagerClient, ListSecretsCommand } from '@aws-sdk/client-secrets-manager';
import { SQSClient, ListQueuesCommand } from '@aws-sdk/client-sqs';
import { CloudWatchLogsClient, DescribeLogGroupsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { CloudWatchClient, DescribeAlarmsCommand } from '@aws-sdk/client-cloudwatch';
import { ApiGatewayV2Client, GetApisCommand } from '@aws-sdk/client-apigatewayv2';
import { SchedulerClient, ListSchedulesCommand } from '@aws-sdk/client-scheduler';
import { IAMClient, ListRolesCommand } from '@aws-sdk/client-iam';
import { assertScope, cfn, outputs, poll, prefix, readStack, region, reportError, requireBudget, stackName } from './common.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const assembly = resolve(root, 'infra/cdk.out');
const templateFile = resolve(assembly, `${stackName}.template.json`);
const s3 = new S3Client({ region });
async function bootstrap() {
  const stack = await readStack('PolicyDemoBootstrap');
  const out = Object.fromEntries((stack?.Outputs || []).map(x => [x.OutputKey, x.OutputValue]));
  const bucket = out.AssetBucketName;
  const role = out.CloudFormationExecutionRoleArn;
  if (!bucket || !role || !out.RuntimeBoundaryArn || stack?.Tags?.find(t => t.Key === 'Project')?.Value !== 'PolicyDemo') throw new Error('Approved tagged bootstrap stack is missing or incomplete. Run the separately approved bootstrap first.');
  process.env.POLICY_ASSET_BUCKET = bucket;
  process.env.AWS_ASSET_BUCKET = bucket;
  process.env.POLICY_RUNTIME_BOUNDARY_ARN = out.RuntimeBoundaryArn;
  return { bucket, role };
}
function synth() {
  execFileSync('npm', ['run', 'aws:synth', '--', '--quiet'], { cwd: root, env: { ...process.env, CDK_DEFAULT_REGION: region, CDK_DISABLE_VERSION_CHECK: '1' }, stdio: 'pipe' });
}
async function publishAssets(bucket) {
  const manifestPath = resolve(assembly, `${stackName}.assets.json`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (Object.keys(manifest.dockerImages || {}).length) throw new Error('Docker/ECR assets are outside the approved ZIP-only bootstrap.');
  for (const asset of Object.values(manifest.files || {})) {
    for (const destination of Object.values(asset.destinations)) {
      if (destination.bucketName !== bucket || !destination.objectKey.startsWith('policy-demo/')) throw new Error('Unexpected asset destination; refusing upload.');
      const source = resolve(assembly, asset.source.path);
      if (!source.startsWith(`${assembly}/`)) throw new Error('Asset path escapes cloud assembly.');
      let temporary;
      try {
        let file = source;
        if (asset.source.packaging === 'zip') {
          temporary = mkdtempSync(resolve(tmpdir(), 'policy-demo-'));
          file = resolve(temporary, 'asset.zip');
          execFileSync('zip', ['-q', '-r', file, '.'], { cwd: source, stdio: 'pipe' });
        } else if (asset.source.packaging !== 'file') throw new Error('Unsupported asset packaging.');
        await s3.send(new PutObjectCommand({ Bucket: bucket, Key: destination.objectKey, Body: readFileSync(file), ServerSideEncryption: 'AES256' }));
      } finally { if (temporary) rmSync(temporary, { recursive: true, force: true }); }
    }
  }
}
async function deploy() {
  await requireBudget(); // No writes, including asset uploads, precede this guard.
  const { bucket, role } = await bootstrap();
  synth();
  await publishAssets(bucket);
  const prior = await readStack();
  if (prior && !['CREATE_COMPLETE','UPDATE_COMPLETE','UPDATE_ROLLBACK_COMPLETE'].includes(prior.StackStatus)) throw new Error('Existing stack needs inspection or destruction before deployment.');
  const ChangeSetName = `demo-${Date.now()}`;
  const template = readFileSync(templateFile, 'utf8');
  let location = { TemplateBody: template };
  if (Buffer.byteLength(template) > 51_200) {
    const Key = 'policy-demo/deploy-template.json';
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key, Body: template, ServerSideEncryption: 'AES256' }));
    location = { TemplateURL: `https://${bucket}.s3.${region}.amazonaws.com/${Key}` };
  }
  await cfn().send(new CreateChangeSetCommand({ StackName: stackName, ChangeSetName, ChangeSetType: prior ? 'UPDATE' : 'CREATE', RoleARN: role, Capabilities: ['CAPABILITY_NAMED_IAM'], Tags: [{ Key: 'Project', Value: 'PolicyDemo' }], ...location }));
  const change = await poll('Change set', () => cfn().send(new DescribeChangeSetCommand({ StackName: stackName, ChangeSetName })), x => ['CREATE_COMPLETE','FAILED'].includes(x.Status), { timeoutMs: 180_000 });
  if (change.Status === 'FAILED') {
    await cfn().send(new DeleteChangeSetCommand({ StackName: stackName, ChangeSetName }));
    if (!prior || !/didn.t contain changes|No updates are to be performed/.test(change.StatusReason || '')) throw new Error('CloudFormation change set failed. Inspect it privately.');
  } else {
    await cfn().send(new ExecuteChangeSetCommand({ StackName: stackName, ChangeSetName }));
    await poll('Runtime deployment', readStack, x => {
      if (!x || /FAILED|ROLLBACK/.test(x.StackStatus)) throw new Error('CloudFormation deployment failed; cleanup is required.');
      return ['CREATE_COMPLETE','UPDATE_COMPLETE'].includes(x.StackStatus);
    }, { timeoutMs: 2_400_000 });
  }
  const out = await outputs();
  if (!out.MigrationFunctionName) throw new Error('Missing migration function output.');
  const lambda = new LambdaClient({ region });
  for (let run = 0; run < 2; run++) {
    const result = await lambda.send(new InvokeCommand({ FunctionName: out.MigrationFunctionName, Payload: Buffer.from('{}') }));
    if (result.FunctionError || result.StatusCode !== 200) throw new Error('Digest-checked migration failed.');
    const response = JSON.parse(Buffer.from(result.Payload || []).toString());
    if (!Array.isArray(response.applied) || (run === 1 && response.applied.length !== 0)) throw new Error('Migration replay was not idempotent.');
  }
  console.log('Demo deployed; digest-checked migrations and their idempotent replay passed. Run smoke, then destroy immediately.');
}

async function collect(client, Command, input, field, inputToken = 'NextToken', outputToken = inputToken) {
  const all = [];
  let token;
  for (let page = 0; page < 1000; page++) {
    const result = await client.send(new Command({ ...input, ...(token ? { [inputToken]: token } : {}) }));
    all.push(...(result[field] || []));
    token = result[outputToken];
    if (!token) return all;
  }
  throw new Error('Cleanup inventory pagination exceeded safe bound.');
}
async function residuals(bucket) {
  const found = [];
  if (await readStack()) found.push('runtime CloudFormation stack');
  const rds = new RDSClient({ region });
  const dbs = await collect(rds, DescribeDBInstancesCommand, {}, 'DBInstances', 'Marker');
  if (dbs.some(x => x.DBInstanceIdentifier?.startsWith(prefix))) found.push('RDS instance');
  const snapshots = await collect(rds, DescribeDBSnapshotsCommand, {}, 'DBSnapshots', 'Marker');
  if (snapshots.some(x => x.DBInstanceIdentifier?.startsWith(prefix))) found.push('RDS snapshot');
  const backups = await collect(rds, DescribeDBInstanceAutomatedBackupsCommand, {}, 'DBInstanceAutomatedBackups', 'Marker');
  if (backups.some(x => x.DBInstanceIdentifier?.startsWith(prefix))) found.push('RDS automated backup');
  const subnetGroups = await collect(rds, DescribeDBSubnetGroupsCommand, {}, 'DBSubnetGroups', 'Marker');
  if (subnetGroups.some(x => x.DBSubnetGroupName?.startsWith(prefix))) found.push('RDS subnet group');
  const ec2 = new EC2Client({ region });
  const filter = [{ Name: 'tag:Project', Values: ['PolicyDemo'] }];
  if ((await collect(ec2, DescribeVpcEndpointsCommand, { Filters: filter }, 'VpcEndpoints')).length) found.push('VPC endpoint');
  const vpcs = await collect(ec2, DescribeVpcsCommand, { Filters: filter }, 'Vpcs');
  if (vpcs.length) {
    found.push('VPC');
    const enis = await collect(ec2, DescribeNetworkInterfacesCommand, { Filters: [{ Name: 'vpc-id', Values: vpcs.map(x => x.VpcId) }] }, 'NetworkInterfaces');
    if (enis.length) found.push('network interface');
  }
  const functions = await collect(new LambdaClient({ region }), ListFunctionsCommand, {}, 'Functions', 'Marker', 'NextMarker');
  if (functions.some(x => x.FunctionName?.startsWith(prefix))) found.push('Lambda function');
  const mappings = await collect(new LambdaClient({ region }), ListEventSourceMappingsCommand, {}, 'EventSourceMappings', 'Marker', 'NextMarker');
  if (mappings.some(x => x.FunctionArn?.includes(':function:policy-demo-') || x.EventSourceArn?.split(':').at(-1)?.startsWith(prefix))) found.push('Lambda event-source mapping');
  const apis = await collect(new ApiGatewayV2Client({ region }), GetApisCommand, {}, 'Items');
  if (apis.some(x => x.Name?.startsWith(prefix) || x.Tags?.Project === 'PolicyDemo')) found.push('HTTP API');
  if ((await collect(new SchedulerClient({ region }), ListSchedulesCommand, { NamePrefix: prefix }, 'Schedules')).length) found.push('Scheduler schedule');
  const cw = new CloudWatchClient({ region });
  if ((await collect(cw, DescribeAlarmsCommand, { AlarmNamePrefix: prefix }, 'MetricAlarms')).length) found.push('CloudWatch alarm');
  if ((await collect(new IAMClient({ region }), ListRolesCommand, { PathPrefix: '/policy-demo/runtime/' }, 'Roles', 'Marker')).length) found.push('runtime IAM role');
  const sqs = new SQSClient({ region });
  if ((await collect(sqs, ListQueuesCommand, { QueueNamePrefix: prefix, MaxResults: 1000 }, 'QueueUrls')).length) found.push('SQS queue');
  const logs = new CloudWatchLogsClient({ region });
  for (const logGroupNamePrefix of ['/aws/lambda/policy-demo-', '/aws/apigateway/policy-demo-']) {
    if ((await collect(logs, DescribeLogGroupsCommand, { logGroupNamePrefix }, 'logGroups', 'nextToken')).length) found.push('log group');
  }
  const secrets = await collect(new SecretsManagerClient({ region }), ListSecretsCommand, { IncludePlannedDeletion: true, Filters: [{ Key: 'name', Values: [prefix] }] }, 'SecretList');
  if (secrets.some(x => x.Name?.startsWith(prefix))) found.push('generated secret (including pending deletion)');
  if ((await collect(s3, ListObjectsV2Command, { Bucket: bucket }, 'Contents', 'ContinuationToken', 'NextContinuationToken')).length) found.push('asset bucket objects');
  return [...new Set(found)];
}
async function cleanAssets(bucket) {
  // The approved bootstrap bucket is dedicated; remove only our application prefix.
  const objects = await collect(s3, ListObjectsV2Command, { Bucket: bucket, Prefix: 'policy-demo/' }, 'Contents', 'ContinuationToken', 'NextContinuationToken');
  for (let i = 0; i < objects.length; i += 1000) {
    const result = await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects.slice(i, i + 1000).map(x => ({ Key: x.Key })), Quiet: true } }));
    if (result.Errors?.length) throw new Error('Some demo asset objects could not be removed.');
  }
}
async function destroy() {
  assertScope(); // Cleanup must remain available if budget checks or deployment fail.
  const { bucket, role } = await bootstrap();
  const failures = [];
  try {
    const stack = await readStack();
    if (stack) {
      if (stack.Tags?.find(t => t.Key === 'Project')?.Value !== 'PolicyDemo') throw new Error('Refusing to delete an untagged/unrecognized stack.');
      if (/_IN_PROGRESS$/.test(stack.StackStatus)) await poll('Pending stack operation', readStack, x => !x || !/_IN_PROGRESS$/.test(x.StackStatus), { timeoutMs: 2_400_000 });
      if (await readStack()) await cfn().send(new DeleteStackCommand({ StackName: stackName, RoleARN: role }));
      await poll('Runtime destruction', readStack, x => { if (x?.StackStatus === 'DELETE_FAILED') throw new Error('Stack deletion failed. Residual resources require inspection.'); return !x; }, { timeoutMs: 2_400_000 });
    }
  } catch { failures.push('runtime stack deletion failed or timed out'); }
  // Still remove only dedicated-prefix assets and inventory residuals after a stack failure.
  try { await cleanAssets(bucket); } catch { failures.push('asset cleanup failed'); }
  try { await verifyClean(bucket, failures.length === 0); } catch (error) { failures.push(error.$metadata ? 'residual inventory could not be completed' : error.message); }
  if (failures.length) throw new Error(`Cleanup incomplete: ${failures.join('; ')}. Inspect AWS privately and retry destroy.`);
}
async function verifyClean(bucket, retry = false) {
  assertScope();
  bucket ||= (await bootstrap()).bucket;
  let found;
  if (retry) await poll('Residual resource cleanup', async () => (found = await residuals(bucket)), x => x.length === 0, { timeoutMs: 300_000, intervalMs: 15_000 }).catch(() => { throw new Error(`Cleanup not verified; residual categories: ${found?.join(', ') || 'inventory check incomplete'}.`); });
  else { found = await residuals(bucket); if (found.length) throw new Error(`Residual demo resources: ${found.join(', ')}.`); }
  console.log('Runtime cleanup verified: no demo database, snapshots/backups, DB subnet groups, endpoints/VPC, functions/mappings, queues, API, schedules, alarms, runtime roles, logs, generated secret, or asset objects remain. Empty bootstrap bucket, bootstrap IAM/OIDC, and budget remain until separately requested full teardown.');
}
function diff() {
  const base = process.env.AWS_DIFF_BASE_TEMPLATE;
  if (!base || !existsSync(base)) throw new Error('AWS_DIFF_BASE_TEMPLATE must point to a trusted offline base template. No live diff is performed.');
  synth();
  execFileSync('npm', ['exec', '--', 'cdk', 'diff', stackName, '--app', assembly, '--template', resolve(base), '--no-change-set', '--no-lookups'], { cwd: resolve(root, 'infra'), stdio: 'inherit', env: { ...process.env, CDK_DISABLE_VERSION_CHECK: '1' } });
}
const action = process.argv[2];
try {
  if (action === 'deploy') await deploy();
  else if (action === 'destroy') await destroy();
  else if (action === 'verify-clean') await verifyClean();
  else if (action === 'diff') diff();
  else throw new Error('Usage: operate.mjs deploy|destroy|verify-clean|diff');
} catch (error) { reportError(error); }
