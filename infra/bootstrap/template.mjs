// ZIP-only bootstrap. No ECR repository, SSM parameter, or customer-managed KMS key.
// All account/region values resolve inside CloudFormation, never in source control.
const sub = (value) => ({ 'Fn::Sub': value });
const ref = (value) => ({ Ref: value });
const arn = (service, resource) => sub(`arn:\${AWS::Partition}:${service}:\${AWS::Region}:\${AWS::AccountId}:${resource}`);
const iamArn = (resource) => sub(`arn:\${AWS::Partition}:iam::\${AWS::AccountId}:${resource}`);
const allow = (Action, Resource, Condition) => ({ Effect: 'Allow', Action, Resource, ...(Condition ? { Condition } : {}) });
const policy = (Statement) => ({ Version: '2012-10-17', Statement });
const trust = (service) => policy([{ Effect: 'Allow', Principal: { Service: service }, Action: 'sts:AssumeRole' }]);
const region = { StringEquals: { 'aws:RequestedRegion': 'us-east-1' } };
const tags = [{ Key: 'Project', Value: 'PolicyDemo' }];
const runtime = iamArn('role/policy-demo/runtime/*');
const boundary = ref('RuntimeBoundary');
const functions = arn('lambda', 'function:policy-demo-*');
const queues = arn('sqs', 'policy-demo-*');
const secrets = arn('secretsmanager', 'secret:policy-demo-*');
const logs = arn('logs', 'log-group:/aws/lambda/policy-demo-*');
const stack = arn('cloudformation', 'stack/PolicyDemo/*');
export const template = {
  AWSTemplateFormatVersion: '2010-09-09',
  Description: 'Approved temporary policy demo deployment access and ZIP assets. No runtime resources.',
  Parameters: {
    Repository: { Type: 'String', Default: 'JordanG2D/durable-policy-workflow', AllowedPattern: '[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+' },
    Branch: { Type: 'String', Default: 'main', AllowedPattern: '[A-Za-z0-9_./-]+' },
    ExistingOidcProviderArn: { Type: 'String', Default: '' },
    BudgetName: { Type: 'String', Default: 'portfolio-demo-budget' },
  },
  Conditions: { CreateProvider: { 'Fn::Equals': [ref('ExistingOidcProviderArn'), ''] } },
  Resources: {
    Assets: { Type: 'AWS::S3::Bucket', DeletionPolicy: 'Delete', UpdateReplacePolicy: 'Delete', Properties: {
      BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] },
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
      OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
      LifecycleConfiguration: { Rules: [{ Id: 'RemoveAbandonedDemoAssets', Status: 'Enabled', ExpirationInDays: 1, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } }] }, Tags: tags,
    } },
    AssetsPolicy: { Type: 'AWS::S3::BucketPolicy', Properties: { Bucket: ref('Assets'), PolicyDocument: policy([
      { Effect: 'Deny', Principal: '*', Action: 's3:*', Resource: [{ 'Fn::GetAtt': ['Assets', 'Arn'] }, sub('${Assets.Arn}/*')], Condition: { Bool: { 'aws:SecureTransport': 'false' } } },
    ]) } },
    GithubProvider: { Type: 'AWS::IAM::OIDCProvider', Condition: 'CreateProvider', Properties: { Url: 'https://token.actions.githubusercontent.com', ClientIdList: ['sts.amazonaws.com'], Tags: tags } },
    RuntimeBoundary: { Type: 'AWS::IAM::ManagedPolicy', Properties: { ManagedPolicyName: 'policy-demo-runtime-boundary', Path: '/policy-demo/', PolicyDocument: policy([
      allow(['logs:CreateLogStream','logs:PutLogEvents'], [logs, sub('arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/lambda/policy-demo-*:log-stream:*')]),
      allow(['secretsmanager:GetSecretValue','secretsmanager:DescribeSecret'], secrets),
      allow(['sqs:SendMessage','sqs:ReceiveMessage','sqs:DeleteMessage','sqs:ChangeMessageVisibility','sqs:GetQueueAttributes'], queues),
      allow(['lambda:InvokeFunction'], functions),
      allow(['xray:PutTraceSegments','xray:PutTelemetryRecords'], '*', region),
      allow(['ec2:CreateNetworkInterface','ec2:DescribeNetworkInterfaces','ec2:DeleteNetworkInterface','ec2:AssignPrivateIpAddresses','ec2:UnassignPrivateIpAddresses','ec2:DescribeSubnets'], '*', region),
    ]) } },
    ExecutionRole: { Type: 'AWS::IAM::Role', Properties: { RoleName: 'policy-demo-cloudformation', Path: '/policy-demo/', AssumeRolePolicyDocument: trust('cloudformation.amazonaws.com'), Tags: tags, Policies: [{ PolicyName: 'ProvisionOnlyDemo', PolicyDocument: policy([
      allow(['s3:GetObject','s3:GetObjectVersion'], sub('${Assets.Arn}/*')),
      allow(['s3:GetBucketLocation'], { 'Fn::GetAtt': ['Assets','Arn'] }),
      allow(['iam:CreateRole','iam:PutRolePermissionsBoundary'], runtime, { StringEquals: { 'iam:PermissionsBoundary': boundary } }),
      allow(['iam:GetRole','iam:DeleteRole','iam:PutRolePolicy','iam:GetRolePolicy','iam:DeleteRolePolicy','iam:TagRole','iam:UntagRole','iam:ListRolePolicies','iam:ListAttachedRolePolicies','iam:UpdateAssumeRolePolicy'], runtime),
      allow(['iam:PassRole'], runtime, { StringEquals: { 'iam:PassedToService': ['lambda.amazonaws.com','scheduler.amazonaws.com'] } }),
      allow(['iam:CreateServiceLinkedRole'], iamArn('role/aws-service-role/rds.amazonaws.com/AWSServiceRoleForRDS'), { StringEquals: { 'iam:AWSServiceName': 'rds.amazonaws.com' } }),
      allow(['ec2:Describe*'], '*', region),
      // IAM evaluates new resources and referenced parents separately.
      ...[
        ['ec2:CreateVpc','vpc',[]],
        ['ec2:CreateSubnet','subnet',['vpc']],
        ['ec2:CreateRouteTable','route-table',['vpc']],
        ['ec2:CreateSecurityGroup','security-group',['vpc']],
        ['ec2:CreateVpcEndpoint','vpc-endpoint',['vpc','subnet','security-group']],
      ].flatMap(([action, type, parents]) => [
        allow([action], arn('ec2', `${type}/*`), { StringEquals: { 'aws:RequestedRegion': 'us-east-1', 'aws:RequestTag/Project': 'PolicyDemo' } }),
        ...(parents.length ? [allow([action], parents.map(parent => arn('ec2', `${parent}/*`)), { StringEquals: { 'aws:RequestedRegion': 'us-east-1', 'ec2:ResourceTag/Project': 'PolicyDemo' } })] : []),
      ]),
      allow(['ec2:CreateTags'], ['vpc','subnet','route-table','security-group','vpc-endpoint'].map(type => arn('ec2', `${type}/*`)), { StringEquals: { 'aws:RequestedRegion': 'us-east-1', 'aws:RequestTag/Project': 'PolicyDemo', 'ec2:CreateAction': ['CreateVpc','CreateSubnet','CreateRouteTable','CreateSecurityGroup','CreateVpcEndpoint'] } }),
      allow(['ec2:AssociateRouteTable','ec2:DisassociateRouteTable'], ['route-table','subnet'].map(type => arn('ec2', `${type}/*`)), { StringEquals: { 'ec2:ResourceTag/Project': 'PolicyDemo' } }),
      allow(['ec2:AuthorizeSecurityGroupIngress','ec2:AuthorizeSecurityGroupEgress','ec2:RevokeSecurityGroupIngress','ec2:RevokeSecurityGroupEgress','ec2:DeleteSecurityGroup'], arn('ec2','security-group/*'), { StringEquals: { 'ec2:ResourceTag/Project': 'PolicyDemo' } }),
      allow(['ec2:ModifyVpcAttribute','ec2:DeleteVpc'], arn('ec2','vpc/*'), { StringEquals: { 'ec2:ResourceTag/Project': 'PolicyDemo' } }),
      allow(['ec2:ModifySubnetAttribute','ec2:DeleteSubnet'], arn('ec2','subnet/*'), { StringEquals: { 'ec2:ResourceTag/Project': 'PolicyDemo' } }),
      allow(['ec2:DeleteRouteTable'], arn('ec2','route-table/*'), { StringEquals: { 'ec2:ResourceTag/Project': 'PolicyDemo' } }),
      allow(['ec2:DeleteVpcEndpoints'], arn('ec2','vpc-endpoint/*'), { StringEquals: { 'ec2:ResourceTag/Project': 'PolicyDemo' } }),
      allow(['rds:CreateDBInstance','rds:ModifyDBInstance','rds:DeleteDBInstance','rds:CreateDBSubnetGroup','rds:ModifyDBSubnetGroup','rds:DeleteDBSubnetGroup','rds:AddTagsToResource','rds:RemoveTagsFromResource','rds:ListTagsForResource'], [arn('rds','db:policy-demo-*'), arn('rds','subgrp:policy-demo-*')]),
      allow(['rds:DescribeDBInstances','rds:DescribeDBSubnetGroups','rds:DescribeDBEngineVersions','rds:DescribeOrderableDBInstanceOptions'], '*', region),
      allow(['secretsmanager:CreateSecret','secretsmanager:DeleteSecret','secretsmanager:DescribeSecret','secretsmanager:GetSecretValue','secretsmanager:PutSecretValue','secretsmanager:UpdateSecret','secretsmanager:TagResource','secretsmanager:UntagResource','secretsmanager:GetResourcePolicy','secretsmanager:PutResourcePolicy','secretsmanager:DeleteResourcePolicy'], secrets),
      allow(['secretsmanager:GetRandomPassword'], '*', region),
      allow(['lambda:CreateFunction','lambda:UpdateFunctionCode','lambda:UpdateFunctionConfiguration','lambda:DeleteFunction','lambda:GetFunction','lambda:GetFunctionConfiguration','lambda:AddPermission','lambda:RemovePermission','lambda:GetPolicy','lambda:TagResource','lambda:UntagResource','lambda:ListTags','lambda:PutFunctionConcurrency','lambda:DeleteFunctionConcurrency','lambda:GetFunctionConcurrency'], functions),
      // Read tags before/after CFN tag propagation; UUIDs are service-generated.
      // A Project tag condition could block the initial stabilization lookup.
      allow(['lambda:ListTags'], arn('lambda','event-source-mapping:*'), region),
      allow(['lambda:CreateEventSourceMapping'], '*', {
        ArnEquals: { 'lambda:FunctionArn': arn('lambda','function:policy-demo-worker') },
        StringEquals: { 'aws:RequestedRegion': 'us-east-1', 'aws:RequestTag/Project': 'PolicyDemo' },
      }),
      allow(['lambda:ListEventSourceMappings'], '*', region),
      allow(['lambda:GetEventSourceMapping'], arn('lambda','event-source-mapping:*'), {
        ArnEquals: { 'lambda:FunctionArn': arn('lambda','function:policy-demo-worker') },
        StringEquals: { 'aws:RequestedRegion': 'us-east-1' },
      }),
      allow(['lambda:UpdateEventSourceMapping','lambda:DeleteEventSourceMapping'], arn('lambda','event-source-mapping:*'), {
        ArnEquals: { 'lambda:FunctionArn': arn('lambda','function:policy-demo-worker') },
        StringEquals: { 'aws:RequestedRegion': 'us-east-1', 'aws:ResourceTag/Project': 'PolicyDemo' },
      }),
      // Tag APIs do not expose FunctionArn. Allow initial tagging of untagged
      // UUID-based mappings, but never overwrite another Project value.
      allow(['lambda:TagResource'], arn('lambda','event-source-mapping:*'), {
        StringEquals: { 'aws:RequestedRegion': 'us-east-1', 'aws:RequestTag/Project': 'PolicyDemo' },
        StringEqualsIfExists: { 'aws:ResourceTag/Project': 'PolicyDemo' },
        'ForAllValues:StringLike': { 'aws:TagKeys': ['Project', 'aws:cloudformation:*'] },
      }),
      // ESM tags are immutable in this disposable demo; no untag grant.
      allow(['sqs:CreateQueue','sqs:DeleteQueue','sqs:GetQueueAttributes','sqs:SetQueueAttributes','sqs:GetQueueUrl','sqs:TagQueue','sqs:UntagQueue','sqs:ListQueueTags'], queues),
      allow(['scheduler:CreateSchedule','scheduler:UpdateSchedule','scheduler:DeleteSchedule','scheduler:GetSchedule'], arn('scheduler','schedule/default/policy-demo-*')),
      allow(['logs:CreateLogGroup','logs:DeleteLogGroup','logs:PutRetentionPolicy','logs:DeleteRetentionPolicy','logs:TagResource','logs:UntagResource','logs:TagLogGroup','logs:ListTagsForResource'], [logs, sub('arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/lambda/policy-demo-*:*')]),
      allow(['logs:DescribeLogGroups'], '*', region),
      allow(['cloudwatch:PutMetricAlarm','cloudwatch:DeleteAlarms','cloudwatch:DescribeAlarms','cloudwatch:TagResource','cloudwatch:UntagResource','cloudwatch:ListTagsForResource'], arn('cloudwatch','alarm:policy-demo-*')),
      allow(['apigateway:POST'], sub('arn:${AWS::Partition}:apigateway:us-east-1::/apis'), { StringEquals: { 'aws:RequestTag/Project': 'PolicyDemo', 'apigateway:Request/ApiName': 'policy-demo-api' } }),
      allow(['apigateway:GET'], sub('arn:${AWS::Partition}:apigateway:us-east-1::/apis*')),
      allow(['apigateway:PATCH','apigateway:DELETE'], sub('arn:${AWS::Partition}:apigateway:us-east-1::/apis/*'), { StringEquals: { 'aws:ResourceTag/Project': 'PolicyDemo' } }),
      // HTTP API child resources have no independently taggable identity. The
      // bounded child-path exception is accessible only through this CFN role.
      allow(['apigateway:POST','apigateway:PATCH','apigateway:DELETE'], ['integrations','routes','stages'].flatMap(kind => [sub(`arn:\${AWS::Partition}:apigateway:us-east-1::/apis/*/${kind}`), sub(`arn:\${AWS::Partition}:apigateway:us-east-1::/apis/*/${kind}/*`)])),
    ]) }] } },
    GithubRole: { Type: 'AWS::IAM::Role', Properties: { RoleName: 'policy-demo-github', Path: '/policy-demo/', MaxSessionDuration: 3600, Tags: tags,
      AssumeRolePolicyDocument: policy([{ Effect: 'Allow', Principal: { Federated: { 'Fn::If': ['CreateProvider', ref('GithubProvider'), ref('ExistingOidcProviderArn')] } }, Action: 'sts:AssumeRoleWithWebIdentity', Condition: { StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com', 'token.actions.githubusercontent.com:sub': sub('repo:${Repository}:ref:refs/heads/${Branch}') } } }]),
      Policies: [{ PolicyName: 'DeployAndVerifyOnlyDemo', PolicyDocument: policy([
        allow(['cloudformation:CreateStack','cloudformation:UpdateStack','cloudformation:DeleteStack','cloudformation:CreateChangeSet','cloudformation:ExecuteChangeSet','cloudformation:DeleteChangeSet','cloudformation:DescribeChangeSet','cloudformation:DescribeStacks','cloudformation:DescribeStackEvents','cloudformation:DescribeStackResources','cloudformation:ListStackResources','cloudformation:GetTemplate'], stack),
        allow(['cloudformation:DescribeChangeSet','cloudformation:ExecuteChangeSet','cloudformation:DeleteChangeSet'], arn('cloudformation','changeSet/demo-*/*')),
        allow(['cloudformation:DescribeStacks'], arn('cloudformation','stack/PolicyDemoBootstrap/*')),
        allow(['iam:PassRole'], { 'Fn::GetAtt': ['ExecutionRole','Arn'] }, { StringEquals: { 'iam:PassedToService': 'cloudformation.amazonaws.com' } }),
        allow(['s3:ListBucket','s3:GetBucketLocation'], { 'Fn::GetAtt': ['Assets','Arn'] }),
        allow(['s3:GetObject','s3:PutObject','s3:DeleteObject'], sub('${Assets.Arn}/*')),
        allow(['lambda:InvokeFunction','lambda:GetFunction'], functions),
        allow(['execute-api:Invoke'], sub('arn:${AWS::Partition}:execute-api:us-east-1:${AWS::AccountId}:*/*/*/*')),
        allow(['sqs:SendMessage','sqs:ReceiveMessage','sqs:DeleteMessage','sqs:GetQueueAttributes','sqs:GetQueueUrl'], queues),
        allow(['budgets:ViewBudget'], sub('arn:${AWS::Partition}:budgets::${AWS::AccountId}:budget/${BudgetName}')),
        allow(['apigateway:GET'], sub('arn:${AWS::Partition}:apigateway:us-east-1::/apis*')),
        allow(['cloudwatch:DescribeAlarms'], arn('cloudwatch','alarm:policy-demo-*')),
        allow(['ec2:DescribeVpcEndpoints','ec2:DescribeNetworkInterfaces','ec2:DescribeVpcs','rds:DescribeDBInstances','rds:DescribeDBSubnetGroups','rds:DescribeDBSnapshots','rds:DescribeDBInstanceAutomatedBackups','logs:DescribeLogGroups','lambda:ListFunctions','lambda:ListEventSourceMappings','iam:ListRoles','scheduler:ListSchedules','sqs:ListQueues','secretsmanager:ListSecrets'], '*', region),
      ]) }],
    } },
  },
  Outputs: { AssetBucketName: { Value: ref('Assets') }, GithubRoleArn: { Value: { 'Fn::GetAtt': ['GithubRole','Arn'] } }, CloudFormationExecutionRoleArn: { Value: { 'Fn::GetAtt': ['ExecutionRole','Arn'] } }, RuntimeBoundaryArn: { Value: ref('RuntimeBoundary') } },
};

// Keep below IAM's 10,240-character aggregate inline-role limit. Network
// permissions live in one project-owned managed policy (6,144-character limit).
const executionStatements = template.Resources.ExecutionRole.Properties.Policies[0].PolicyDocument.Statement;
const networkStatements = executionStatements.filter(s => s.Action.some(action => action.startsWith('ec2:')));
template.Resources.ExecutionRole.Properties.Policies[0].PolicyDocument.Statement = executionStatements.filter(s => !networkStatements.includes(s));
template.Resources.ExecutionNetworkPolicy = { Type: 'AWS::IAM::ManagedPolicy', Properties: {
  ManagedPolicyName: 'policy-demo-execution-network', Path: '/policy-demo/',
  Roles: [ref('ExecutionRole')], PolicyDocument: policy(networkStatements),
} };
