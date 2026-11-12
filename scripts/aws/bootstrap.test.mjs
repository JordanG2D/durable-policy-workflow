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
  assert.equal(trust.Condition.StringEquals['token.actions.githubusercontent.com:sub']['Fn::Sub'], 'repo:${Repository}:ref:refs/heads/${Branch}');
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
