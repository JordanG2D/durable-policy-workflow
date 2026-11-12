import { test } from 'node:test';
import assert from 'node:assert/strict';
import { template } from '../../infra/bootstrap/template.mjs';
const resources = Object.values(template.Resources);
const statement = role => [...template.Resources[role].Properties.Policies.flatMap(p => p.PolicyDocument.Statement), ...Object.values(template.Resources).filter(r => r.Type === 'AWS::IAM::ManagedPolicy' && r.Properties.Roles?.some(ref => ref.Ref === role)).flatMap(r => r.Properties.PolicyDocument.Statement)];
const actions = s => Array.isArray(s.Action) ? s.Action : [s.Action];
test('ZIP-only bootstrap has exactly the named resource classes and deletes its bucket', () => {
  assert.deepEqual([...new Set(resources.map(r => r.Type))].sort(), ['AWS::IAM::ManagedPolicy','AWS::IAM::OIDCProvider','AWS::IAM::Role','AWS::S3::Bucket','AWS::S3::BucketPolicy']);
  assert.equal(template.Resources.Assets.DeletionPolicy, 'Delete');
  assert.equal(template.Resources.Assets.Properties.PublicAccessBlockConfiguration.BlockPublicPolicy, true);
  assert.equal(resources.some(r => /ECR|SSM|KMS|Lambda/.test(r.Type)), false);
});
test('OIDC trust binds audience, exact repository and main branch', () => {
  const trust = template.Resources.GithubRole.Properties.AssumeRolePolicyDocument.Statement[0];
  assert.equal(trust.Action, 'sts:AssumeRoleWithWebIdentity');
  assert.equal(trust.Condition.StringEquals['token.actions.githubusercontent.com:aud'], 'sts.amazonaws.com');
  const [subject, names] = trust.Condition.StringEquals['token.actions.githubusercontent.com:sub']['Fn::Sub'];
  assert.equal(subject, 'repo:${OwnerName}@${RepositoryOwnerId}/${RepositoryName}@${RepositoryId}:ref:refs/heads/${Branch}');
  assert.deepEqual(names, {
    OwnerName: { 'Fn::Select': [0, { 'Fn::Split': ['/', { Ref: 'Repository' }] }] },
    RepositoryName: { 'Fn::Select': [1, { 'Fn::Split': ['/', { Ref: 'Repository' }] }] },
  });
  const defaults = Object.fromEntries(Object.entries(template.Parameters).map(([key, value]) => [key, value.Default]));
  const [OwnerName, RepositoryName] = defaults.Repository.split('/');
  assert.equal(Object.hasOwn(template.Parameters.RepositoryOwnerId, 'Default'), false);
  assert.equal(Object.hasOwn(template.Parameters.RepositoryId, 'Default'), false);
  const values = { ...defaults, OwnerName, RepositoryName, RepositoryOwnerId: '0', RepositoryId: '0' };
  const resolved = subject.replace(/\$\{([^}]+)\}/g, (_, key) => values[key]);
  assert.equal(resolved, 'repo:JordanG2D@0/durable-policy-workflow@0:ref:refs/heads/main');
  assert.equal(resolved.includes('*'), false);
  assert.equal(trust.Condition.StringLike, undefined);
  assert.deepEqual(trust.Principal.Federated, { 'Fn::If': ['CreateProvider', { Ref: 'GithubProvider' }, { Ref: 'ExistingOidcProviderArn' }] });
  assert.equal(template.Parameters.Branch.Default, 'main');
});
test('execution role requires boundary for role creation and cannot change bootstrap roles', () => {
  for (const s of statement('ExecutionRole')) {
    if (actions(s).some(a => a === 'iam:CreateRole' || a === 'iam:PutRolePermissionsBoundary')) {
      assert.equal(s.Resource['Fn::Sub'], 'arn:${AWS::Partition}:iam::${AWS::AccountId}:role/policy-demo/runtime/*');
      assert.deepEqual(s.Condition.StringEquals['iam:PermissionsBoundary'], { Ref: 'RuntimeBoundary' });
    }
    assert.ok(!actions(s).includes('iam:*'));
    assert.ok(!actions(s).includes('sts:AssumeRole'));
  }
});
test('EC2 writes cannot tag arbitrary existing resources into the project', () => {
  for (const s of statement('ExecutionRole')) {
    if (actions(s).includes('ec2:CreateTags')) assert.ok(s.Condition.StringEquals['ec2:CreateAction']);
    if (actions(s).some(a => /^ec2:(Delete|Modify|Authorize|Revoke|Associate|Disassociate)/.test(a))) {
      assert.equal(s.Condition.StringEquals['ec2:ResourceTag/Project'], 'PolicyDemo');
      assert.notEqual(s.Resource, '*');
    }
  }
});
test('deployment role cannot provision IAM or EC2 directly', () => {
  for (const s of statement('GithubRole')) {
    assert.ok(!actions(s).some(a => /^iam:(Create|Put|Update|Delete)/.test(a)));
    assert.ok(!actions(s).some(a => /^ec2:(Create|Delete|Modify|Authorize|Revoke)/.test(a)));
    assert.ok(!actions(s).includes('*'));
  }
});

test('IAM inline and managed policies have room below their size quotas', () => {
  for (const r of Object.values(template.Resources)) {
    if (r.Type === 'AWS::IAM::ManagedPolicy') assert.ok(JSON.stringify(r.Properties.PolicyDocument).length < 6000);
    if (r.Type === 'AWS::IAM::Role') assert.ok(JSON.stringify(r.Properties.Policies ?? []).length < 10000);
  }
});

test('execution role can read ESM tags without widening write authority or requiring preexisting tags', () => {
  const esmArn = 'arn:${AWS::Partition}:lambda:${AWS::Region}:${AWS::AccountId}:event-source-mapping:*';
  const esmReads = statement('ExecutionRole').filter(s => actions(s).includes('lambda:ListTags') && s.Resource?.['Fn::Sub'] === esmArn);
  assert.equal(esmReads.length, 1);
  assert.deepEqual(actions(esmReads[0]), ['lambda:ListTags']);
  assert.deepEqual(esmReads[0].Condition, { StringEquals: { 'aws:RequestedRegion': 'us-east-1' } });
  for (const s of statement('ExecutionRole').filter(s => actions(s).includes('lambda:ListTags'))) {
    assert.notEqual(s.Resource, '*');
    assert.ok([esmArn, 'arn:${AWS::Partition}:lambda:${AWS::Region}:${AWS::AccountId}:function:policy-demo-*'].includes(s.Resource['Fn::Sub']));
  }
});

test('ESM creation and lifecycle bind the worker; no wildcard Lambda tag writes', () => {
  const statements = statement('ExecutionRole');
  const worker = { 'Fn::Sub': 'arn:${AWS::Partition}:lambda:${AWS::Region}:${AWS::AccountId}:function:policy-demo-worker' };
  const esm = 'arn:${AWS::Partition}:lambda:${AWS::Region}:${AWS::AccountId}:event-source-mapping:*';
  for (const action of ['CreateEventSourceMapping','GetEventSourceMapping','UpdateEventSourceMapping','DeleteEventSourceMapping']) {
    const grants = statements.filter(s => actions(s).includes(`lambda:${action}`));
    assert.equal(grants.length, 1);
    assert.deepEqual(grants[0].Condition.ArnEquals['lambda:FunctionArn'], worker);
    assert.equal(grants[0].Condition.StringEquals['aws:RequestedRegion'], 'us-east-1');
    if (action === 'CreateEventSourceMapping') {
      assert.equal(grants[0].Resource, '*');
      assert.equal(grants[0].Condition.StringEquals['aws:RequestTag/Project'], 'PolicyDemo');
    } else assert.equal(grants[0].Resource['Fn::Sub'], esm);
    if (['UpdateEventSourceMapping','DeleteEventSourceMapping'].includes(action)) assert.equal(grants[0].Condition.StringEquals['aws:ResourceTag/Project'], 'PolicyDemo');
  }
  for (const s of statements.filter(s => actions(s).some(a => ['lambda:TagResource','lambda:UntagResource'].includes(a)))) assert.notEqual(s.Resource, '*');
  const tag = statements.find(s => actions(s).includes('lambda:TagResource') && s.Resource['Fn::Sub'] === esm);
  assert.equal(tag.Condition.StringEquals['aws:RequestTag/Project'], 'PolicyDemo');
  assert.equal(tag.Condition.StringEqualsIfExists['aws:ResourceTag/Project'], 'PolicyDemo');
  assert.deepEqual(tag.Condition['ForAllValues:StringLike']['aws:TagKeys'], ['Project', 'aws:cloudformation:*']);
  assert.equal(tag.Condition.ArnEquals, undefined);
  assert.equal(statements.some(s => actions(s).includes('lambda:UntagResource') && s.Resource['Fn::Sub'] === esm), false);
});

test('IAM absent-role fallback allows only exact-name root-path read/delete', () => {
  const names = ['api','migration','publisher','worker','scheduler'];
  const arns = names.map(name => ({ 'Fn::Sub': `arn:\${AWS::Partition}:iam::\${AWS::AccountId}:role/policy-demo-${name}` }));
  const grants = statement('ExecutionRole').filter(s => Array.isArray(s.Resource) && s.Resource.some(r => names.some(name => r['Fn::Sub']?.endsWith(`:role/policy-demo-${name}`))));
  assert.equal(grants.length, 1);
  assert.deepEqual(grants[0].Action, ['iam:GetRole','iam:DeleteRole']);
  assert.deepEqual(grants[0].Resource, arns);
  assert.equal(JSON.stringify(grants[0].Resource).includes('*'), false);
});
test('API tag POST is encoded HTTP-only with fail-closed request tags, no untag', () => {
  const grants = statement('ExecutionRole').filter(s => JSON.stringify(s.Resource).includes('/tags/'));
  assert.equal(grants.length, 1);
  assert.deepEqual(grants[0].Action, ['apigateway:POST']);
  assert.equal(grants[0].Resource['Fn::Sub'], 'arn:${AWS::Partition}:apigateway:us-east-1::/tags/arn%3A${AWS::Partition}%3Aapigateway%3Aus-east-1%3A%3A%2Fv2%2Fapis%2F*');
  assert.deepEqual(grants[0].Condition, {
    StringEquals: { 'aws:RequestTag/Project': 'PolicyDemo' },
    'ForAllValues:StringLike': { 'aws:TagKeys': ['Project', 'aws:cloudformation:*'] },
  });
});
