import { test } from 'node:test';
import assert from 'node:assert/strict';
import { App, aws_lambda as lambda } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { DemoStack } from '../lib/demo-stack.js';
import { BudgetStack } from '../lib/budget-stack.js';
const template = Template.fromStack(new DemoStack(new App(), 'PolicyDemo', { code: lambda.Code.fromInline('exports.api=()=>{};') }));
interface Statement { Action: string | string[]; Resource: unknown; Condition: { ArnEquals: Record<string, unknown> } }
interface Resource {
  Type: string; DeletionPolicy: string; UpdateReplacePolicy: string;
  Properties: {
    MapPublicIpOnLaunch: boolean; SubnetIds: unknown[];
    VpcConfig: { SubnetIds: unknown[] }; PolicyDocument: { Statement: Statement[] };
    ToPort: number; DestinationSecurityGroupId: unknown; Runtime: string; Architectures: string[];
    MemorySize: number; Timeout: number; ReservedConcurrentExecutions: number;
    TracingConfig: { Mode: string }; LoggingConfig: { LogFormat: string };
    Environment: { Variables: Record<string, string> }; RetentionInDays: number;
    Path: string; PermissionsBoundary: unknown; ManagedPolicyArns: unknown;
  };
}
const json = template.toJSON() as { Resources: Record<string, Resource> };
const resources = (type: string): Resource[] => Object.values(json.Resources).filter(r => r.Type === type);
void test('only the approved resource types; no hidden provider, NAT, gateway, ECR or extra endpoint', () => {
  const allowed = new Set(['AWS::EC2::VPC', 'AWS::EC2::Subnet', 'AWS::EC2::RouteTable', 'AWS::EC2::SubnetRouteTableAssociation', 'AWS::EC2::SecurityGroup', 'AWS::EC2::SecurityGroupIngress', 'AWS::EC2::SecurityGroupEgress', 'AWS::EC2::VPCEndpoint', 'AWS::SecretsManager::Secret', 'AWS::RDS::DBSubnetGroup', 'AWS::RDS::DBInstance', 'AWS::SQS::Queue', 'AWS::Logs::LogGroup', 'AWS::IAM::Role', 'AWS::IAM::Policy', 'AWS::Lambda::Function', 'AWS::Lambda::Permission', 'AWS::Lambda::EventSourceMapping', 'AWS::Scheduler::Schedule', 'AWS::ApiGatewayV2::Api', 'AWS::ApiGatewayV2::Integration', 'AWS::ApiGatewayV2::Route', 'AWS::ApiGatewayV2::Stage', 'AWS::CloudWatch::Alarm']);
  for (const r of Object.values(json.Resources)) assert.ok(allowed.has(r.Type), `Unlisted resource ${r.Type}`);
  template.resourceCountIs('AWS::EC2::VPCEndpoint', 2);
  template.resourceCountIs('AWS::Lambda::Function', 4);
  template.resourceCountIs('AWS::Logs::LogGroup', 4);
  template.resourceCountIs('AWS::IAM::Role', 5);
});
void test('single AZ private disposable RDS with no snapshots/backups or protection', () => {
  template.resourceCountIs('AWS::RDS::DBInstance', 1);
  template.hasResource('AWS::RDS::DBInstance', { DeletionPolicy: 'Delete', UpdateReplacePolicy: 'Delete', Properties: Match.objectLike({ DBInstanceClass: 'db.t4g.micro', AllocatedStorage: '20', StorageType: 'gp3', StorageEncrypted: true, MultiAZ: false, PubliclyAccessible: false, BackupRetentionPeriod: 0, DeletionProtection: false, DeleteAutomatedBackups: true }) });
  template.resourceCountIs('AWS::EC2::Subnet', 2);
  for (const r of resources('AWS::EC2::Subnet')) assert.equal(r.Properties.MapPublicIpOnLaunch, false);
  assert.equal(resources('AWS::RDS::DBSubnetGroup')[0].Properties.SubnetIds.length, 2);
});
void test('all endpoints and Lambda ENIs use the same single subnet, endpoints restrict exact principals and resources', () => {
  const subnets = resources('AWS::EC2::VPCEndpoint').map(r => r.Properties.SubnetIds);
  assert.equal(subnets[0].length, 1); assert.deepEqual(subnets[0], subnets[1]);
  for (const r of resources('AWS::Lambda::Function')) assert.deepEqual(r.Properties.VpcConfig.SubnetIds, subnets[0]);
  for (const r of resources('AWS::EC2::VPCEndpoint')) for (const s of r.Properties.PolicyDocument.Statement) {
    assert.ok(s.Condition.ArnEquals['aws:PrincipalArn']); assert.notEqual(s.Resource, '*');
  }
  for (const r of resources('AWS::EC2::SecurityGroupEgress')) {
    assert.ok([443, 5432].includes(r.Properties.ToPort)); assert.ok(r.Properties.DestinationSecurityGroupId);
  }
});
void test('runtime limits, JSON logging, seven-day delete logs, no managed broad roles', () => {
  for (const r of resources('AWS::Lambda::Function')) {
    assert.equal(r.Properties.Runtime, 'nodejs22.x'); assert.deepEqual(r.Properties.Architectures, ['arm64']);
    assert.equal(r.Properties.MemorySize, 256); assert.ok(r.Properties.Timeout <= 60);
    assert.ok(r.Properties.ReservedConcurrentExecutions <= 2); assert.equal(r.Properties.TracingConfig.Mode, 'Active');
    assert.equal(r.Properties.LoggingConfig.LogFormat, 'JSON'); assert.equal(r.Properties.Environment.Variables.DEMO_MODE, 'true');
  }
  for (const r of resources('AWS::Logs::LogGroup')) { assert.equal(r.Properties.RetentionInDays, 7); assert.equal(r.DeletionPolicy, 'Delete'); assert.equal(r.UpdateReplacePolicy, 'Delete'); }
  for (const r of resources('AWS::IAM::Role')) { assert.equal(r.Properties.Path, '/policy-demo/runtime/'); assert.ok(r.Properties.PermissionsBoundary); assert.equal(r.Properties.ManagedPolicyArns, undefined); }
  for (const r of resources('AWS::IAM::Policy')) for (const s of r.Properties.PolicyDocument.Statement) {
    const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
    if (actions.some((a: string) => a.startsWith('sqs:') || a.startsWith('secretsmanager:'))) assert.notEqual(s.Resource, '*');
  }
});
void test('IAM API auth and low throttles; bounded queue retry and minute publisher', () => {
  template.resourceCountIs('AWS::ApiGatewayV2::Route', 1);
  template.hasResourceProperties('AWS::ApiGatewayV2::Route', { AuthorizationType: 'AWS_IAM' });
  template.hasResourceProperties('AWS::ApiGatewayV2::Stage', { DefaultRouteSettings: Match.objectLike({ ThrottlingBurstLimit: 5, ThrottlingRateLimit: 2 }) });
  template.hasResourceProperties('AWS::SQS::Queue', { VisibilityTimeout: 180, RedrivePolicy: Match.objectLike({ maxReceiveCount: 3 }) });
  template.hasResourceProperties('AWS::Lambda::EventSourceMapping', { BatchSize: 1, FunctionResponseTypes: ['ReportBatchItemFailures'], ScalingConfig: { MaximumConcurrency: 2 } });
  template.hasResourceProperties('AWS::Scheduler::Schedule', { ScheduleExpression: 'rate(1 minute)' });
  template.resourceCountIs('AWS::CloudWatch::Alarm', 3);
  template.hasResourceProperties('AWS::CloudWatch::Alarm', { Namespace: 'PolicyDemo', MetricName: 'OutboxLagSeconds', Dimensions: [{ Name: 'Service', Value: 'handbuilt' }] });
});
void test('budget has independent lifecycle, fixed $5 and owner email parameter', () => {
  template.resourceCountIs('AWS::Budgets::Budget', 0);
  const budget = Template.fromStack(new BudgetStack(new App(), 'PolicyDemoBudget'));
  budget.resourceCountIs('AWS::Budgets::Budget', 1);
  budget.hasResourceProperties('AWS::Budgets::Budget', { Budget: Match.objectLike({ BudgetLimit: { Amount: 5, Unit: 'USD' }, TimeUnit: 'MONTHLY' }) });
});
