import { Stack, Tags, CfnOutput, Duration, Fn, RemovalPolicy, type StackProps, aws_ec2 as ec2, aws_iam as iam, aws_lambda as lambda, aws_logs as logs, aws_rds as rds, aws_secretsmanager as secrets, aws_sqs as sqs, aws_scheduler as scheduler, aws_apigatewayv2 as apigw, aws_cloudwatch as cloudwatch } from 'aws-cdk-lib';
import { Construct } from 'constructs';
export interface DemoStackProps extends StackProps { readonly code: lambda.Code; readonly runtimeBoundaryArn?: string }
/** No lookups, NAT, public IPs, custom resource providers, or implicit bootstrap. */
export class DemoStack extends Stack {
  constructor(scope: Construct, id: string, props: DemoStackProps) {
    super(scope, id, props);
    Tags.of(this).add('Project', 'PolicyDemo');
    const boundary = iam.ManagedPolicy.fromManagedPolicyArn(this, 'RuntimeBoundary', props.runtimeBoundaryArn ?? Fn.sub('arn:${AWS::Partition}:iam::${AWS::AccountId}:policy/policy-demo/policy-demo-runtime-boundary'));
    const vpc = new ec2.CfnVPC(this, 'Vpc', { cidrBlock: '10.42.0.0/16', enableDnsHostnames: true, enableDnsSupport: true });
    const subnets = ['a', 'b'].map((az, i) => new ec2.CfnSubnet(this, `IsolatedSubnet${az}`, { vpcId: vpc.ref, cidrBlock: `10.42.${i}.0/24`, availabilityZone: Fn.sub(`\${AWS::Region}${az}`), mapPublicIpOnLaunch: false }));
    subnets.forEach((s, i) => {
      const rt = new ec2.CfnRouteTable(this, `IsolatedRoutes${i}`, { vpcId: vpc.ref });
      new ec2.CfnSubnetRouteTableAssociation(this, `IsolatedRouteAssociation${i}`, { routeTableId: rt.ref, subnetId: s.ref });
    });
    // Explicit dummy egress prevents EC2's automatic allow-all default; matches CDK's convention.
    const noEgress = [{ ipProtocol: 'icmp', cidrIp: '255.255.255.255/32', fromPort: 252, toPort: 86 }];
    const sg = (name: string) => new ec2.CfnSecurityGroup(this, name, { vpcId: vpc.ref, groupDescription: `Policy demo ${name}`, securityGroupEgress: noEgress });
    const appSg = sg('LambdaSg'), dbSg = sg('DatabaseSg'), endpointSg = sg('EndpointSg');
    for (const [name, target, port] of [['Postgres', dbSg, 5432], ['Services', endpointSg, 443]] as const) {
      new ec2.CfnSecurityGroupIngress(this, `${name}Ingress`, { groupId: target.attrGroupId, sourceSecurityGroupId: appSg.attrGroupId, ipProtocol: 'tcp', fromPort: port, toPort: port });
      new ec2.CfnSecurityGroupEgress(this, `${name}Egress`, { groupId: appSg.attrGroupId, destinationSecurityGroupId: target.attrGroupId, ipProtocol: 'tcp', fromPort: port, toPort: port });
    }
    const secret = new secrets.CfnSecret(this, 'DatabaseSecret', { name: 'policy-demo-db-credentials', description: 'Disposable policy database credentials', generateSecretString: { secretStringTemplate: JSON.stringify({ username: 'policy_admin' }), generateStringKey: 'password', passwordLength: 32, excludePunctuation: true } });
    secret.applyRemovalPolicy(RemovalPolicy.DESTROY);
    const subnetGroup = new rds.CfnDBSubnetGroup(this, 'DatabaseSubnetGroup', { dbSubnetGroupName: 'policy-demo-subnets', dbSubnetGroupDescription: 'Two isolated subnets required by RDS', subnetIds: subnets.map(s => s.ref) });
    const db = new rds.CfnDBInstance(this, 'Database', {
      dbInstanceIdentifier: 'policy-demo-db', engine: 'postgres', engineLifecycleSupport: 'open-source-rds-extended-support-disabled', dbInstanceClass: 'db.t4g.micro', allocatedStorage: '20', storageType: 'gp3', storageEncrypted: true,
      multiAz: false, publiclyAccessible: false, availabilityZone: Fn.sub('${AWS::Region}a'), dbSubnetGroupName: subnetGroup.ref,
      vpcSecurityGroups: [dbSg.attrGroupId], dbName: 'policy', port: '5432',
      masterUsername: Fn.sub('{{resolve:secretsmanager:${Secret}:SecretString:username}}', { Secret: secret.ref }),
      masterUserPassword: Fn.sub('{{resolve:secretsmanager:${Secret}:SecretString:password}}', { Secret: secret.ref }),
      backupRetentionPeriod: 0, deleteAutomatedBackups: true, deletionProtection: false, autoMinorVersionUpgrade: true, copyTagsToSnapshot: false,
    });
    db.applyRemovalPolicy(RemovalPolicy.DESTROY);
    const dlq = new sqs.CfnQueue(this, 'DeadLetterQueue', { queueName: 'policy-demo-dlq', redriveAllowPolicy: { redrivePermission: 'byQueue', sourceQueueArns: [Fn.sub('arn:${AWS::Partition}:sqs:${AWS::Region}:${AWS::AccountId}:policy-demo-work')] }, messageRetentionPeriod: 345600, sqsManagedSseEnabled: true });
    const queue = new sqs.CfnQueue(this, 'WorkQueue', { queueName: 'policy-demo-work', visibilityTimeout: 180, messageRetentionPeriod: 86400, receiveMessageWaitTimeSeconds: 20, sqsManagedSseEnabled: true, redrivePolicy: { deadLetterTargetArn: dlq.attrArn, maxReceiveCount: 3 } });
    const roles = {} as Record<'api' | 'publisher' | 'worker' | 'migration', iam.Role>;
    const functions = {} as Record<keyof typeof roles, lambda.Function>;
    for (const name of ['api', 'publisher', 'worker', 'migration'] as const) {
      const group = new logs.CfnLogGroup(this, `${name}Logs`, { logGroupName: `/aws/lambda/policy-demo-${name}`, retentionInDays: 7 });
      group.applyRemovalPolicy(RemovalPolicy.DESTROY);
      const role = new iam.Role(this, `${name}Role`, { roleName: `policy-demo-${name}`, path: '/policy-demo/runtime/', permissionsBoundary: boundary, assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
      roles[name] = role;
      const grant = (actions: string[], resources: string[]) => role.addToPolicy(new iam.PolicyStatement({ actions, resources }));
      grant(['logs:CreateLogStream', 'logs:PutLogEvents'], [group.attrArn]);
      grant(['secretsmanager:GetSecretValue'], [secret.ref]);
      // Lambda ENI management and X-Ray writes require wildcard resources.
      grant(['ec2:CreateNetworkInterface', 'ec2:DescribeNetworkInterfaces', 'ec2:DescribeSubnets', 'ec2:DeleteNetworkInterface', 'ec2:AssignPrivateIpAddresses', 'ec2:UnassignPrivateIpAddresses'], ['*']);
      grant(['xray:PutTraceSegments', 'xray:PutTelemetryRecords'], ['*']);
      if (name === 'publisher') grant(['sqs:SendMessage'], [queue.attrArn]);
      if (name === 'worker') {
        grant(['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes', 'sqs:ChangeMessageVisibility'], [queue.attrArn]);
        grant(['sqs:SendMessage'], [dlq.attrArn]);
      }
      const fn = new lambda.Function(this, `${name}Function`, {
        functionName: `policy-demo-${name}`, runtime: lambda.Runtime.NODEJS_22_X, architecture: lambda.Architecture.ARM_64, code: props.code, handler: `index.${name}`, role,
        timeout: Duration.seconds(name === 'migration' ? 60 : name === 'worker' ? 30 : 20), memorySize: 256,
        reservedConcurrentExecutions: name === 'api' || name === 'worker' ? 2 : 1, tracing: lambda.Tracing.ACTIVE,
        environment: { DATABASE_SECRET_ARN: secret.ref, DATABASE_HOST: db.attrEndpointAddress, DATABASE_PORT: '5432', DATABASE_NAME: 'policy', QUEUE_URL: queue.ref, DLQ_URL: dlq.ref, DEMO_MODE: 'true', NODE_EXTRA_CA_CERTS: '/var/runtime/ca-cert.pem', RELAY_LEASE_MS: '45000' },
      });
      // L1 override avoids L2 VPC lookups and log-retention provider custom resources.
      const cfn = fn.node.defaultChild as lambda.CfnFunction;
      cfn.vpcConfig = { subnetIds: [subnets[0].ref], securityGroupIds: [appSg.attrGroupId], ipv6AllowedForDualStack: false };
      cfn.loggingConfig = { logFormat: 'JSON', logGroup: group.ref, applicationLogLevel: 'INFO', systemLogLevel: 'WARN' };
      functions[name] = fn;
    }
    const endpoint = (name: string, service: string, statements: object[]) => new ec2.CfnVPCEndpoint(this, name, { vpcId: vpc.ref, vpcEndpointType: 'Interface', serviceName: Fn.sub(`com.amazonaws.\${AWS::Region}.${service}`), privateDnsEnabled: true, subnetIds: [subnets[0].ref], securityGroupIds: [endpointSg.attrGroupId], policyDocument: { Version: '2012-10-17', Statement: statements } });
    const secretsEndpoint = endpoint('SecretsEndpoint', 'secretsmanager', [{ Effect: 'Allow', Principal: '*', Action: ['secretsmanager:GetSecretValue'], Resource: secret.ref, Condition: { ArnEquals: { 'aws:PrincipalArn': Object.values(roles).map(r => r.roleArn) } } }]);
    const sqsEndpoint = endpoint('SqsEndpoint', 'sqs', [
      { Effect: 'Allow', Principal: '*', Action: ['sqs:SendMessage'], Resource: queue.attrArn, Condition: { ArnEquals: { 'aws:PrincipalArn': roles.publisher.roleArn } } },
      { Effect: 'Allow', Principal: '*', Action: ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes', 'sqs:ChangeMessageVisibility'], Resource: queue.attrArn, Condition: { ArnEquals: { 'aws:PrincipalArn': roles.worker.roleArn } } },
      { Effect: 'Allow', Principal: '*', Action: ['sqs:SendMessage'], Resource: dlq.attrArn, Condition: { ArnEquals: { 'aws:PrincipalArn': roles.worker.roleArn } } },
    ]);
    Object.values(functions).forEach(fn => fn.node.addDependency(secretsEndpoint, sqsEndpoint));
    new lambda.CfnEventSourceMapping(this, 'WorkerMessages', { functionName: functions.worker.functionName, eventSourceArn: queue.attrArn, batchSize: 1, enabled: true, functionResponseTypes: ['ReportBatchItemFailures'], scalingConfig: { maximumConcurrency: 2 } });
    const scheduleRole = new iam.Role(this, 'PublisherScheduleRole', {
      roleName: 'policy-demo-scheduler', path: '/policy-demo/runtime/', permissionsBoundary: boundary,
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com', { conditions: { StringEquals: { 'aws:SourceAccount': this.account }, ArnEquals: { 'aws:SourceArn': Fn.sub('arn:${AWS::Partition}:scheduler:${AWS::Region}:${AWS::AccountId}:schedule-group/default') } } }),
    });
    scheduleRole.addToPolicy(new iam.PolicyStatement({ actions: ['lambda:InvokeFunction'], resources: [functions.publisher.functionArn] }));
    new scheduler.CfnSchedule(this, 'PublisherSchedule', { name: 'policy-demo-publisher', scheduleExpression: 'rate(1 minute)', flexibleTimeWindow: { mode: 'OFF' }, state: 'ENABLED', target: { arn: functions.publisher.functionArn, roleArn: scheduleRole.roleArn, retryPolicy: { maximumEventAgeInSeconds: 60, maximumRetryAttempts: 0 }, input: '{}' } });
    const api = new apigw.CfnApi(this, 'HttpApi', { name: 'policy-demo-api', protocolType: 'HTTP' });
    const integration = new apigw.CfnIntegration(this, 'ApiIntegration', { apiId: api.ref, integrationType: 'AWS_PROXY', integrationUri: functions.api.functionArn, payloadFormatVersion: '2.0', timeoutInMillis: 20000 });
    new apigw.CfnRoute(this, 'IamRoute', { apiId: api.ref, routeKey: '$default', authorizationType: 'AWS_IAM', target: Fn.join('/', ['integrations', integration.ref]) });
    new apigw.CfnStage(this, 'ApiStage', { apiId: api.ref, stageName: '$default', autoDeploy: true, defaultRouteSettings: { throttlingBurstLimit: 5, throttlingRateLimit: 2, detailedMetricsEnabled: false } });
    new lambda.CfnPermission(this, 'ApiInvokePermission', { action: 'lambda:InvokeFunction', functionName: functions.api.functionName, principal: 'apigateway.amazonaws.com', sourceArn: Fn.sub('arn:${AWS::Partition}:execute-api:${AWS::Region}:${AWS::AccountId}:${Api}/*', { Api: api.ref }), sourceAccount: this.account });
    new cloudwatch.CfnAlarm(this, 'DlqDepthAlarm', { alarmName: 'policy-demo-dlq-depth', alarmDescription: 'Message exhausted worker retries or workflow failed permanently.', namespace: 'AWS/SQS', metricName: 'ApproximateNumberOfMessagesVisible', statistic: 'Maximum', period: 60, evaluationPeriods: 1, threshold: 0, comparisonOperator: 'GreaterThanThreshold', treatMissingData: 'notBreaching', dimensions: [{ name: 'QueueName', value: dlq.attrQueueName }] });
    new cloudwatch.CfnAlarm(this, 'LambdaErrorRateAlarm', {
      alarmName: 'policy-demo-lambda-error-rate',
      alarmDescription: 'Combined demo Lambda error rate exceeds 5% for five minutes.', evaluationPeriods: 1, threshold: 5, comparisonOperator: 'GreaterThanThreshold', treatMissingData: 'notBreaching',
      metrics: [...Object.entries(functions).flatMap(([name, fn], i) => ['Errors', 'Invocations'].map(metric => ({ id: `${metric === 'Errors' ? 'e' : 'i'}${i}`, label: `${name} ${metric}`, returnData: false, metricStat: { period: 300, stat: 'Sum', metric: { namespace: 'AWS/Lambda', metricName: metric, dimensions: [{ name: 'FunctionName', value: fn.functionName }] } } }))), { id: 'rate', expression: 'IF((i0+i1+i2+i3)>0,100*(e0+e1+e2+e3)/(i0+i1+i2+i3),0)', returnData: true }],
    });
    new cloudwatch.CfnAlarm(this, 'OutboxLagAlarm', { alarmName: 'policy-demo-outbox-lag', alarmDescription: 'Oldest unpublished outbox event exceeds two minutes; publisher emits EMF.', namespace: 'PolicyDemo', metricName: 'OutboxLagSeconds', statistic: 'Maximum', period: 60, dimensions: [{ name: 'Service', value: 'handbuilt' }], evaluationPeriods: 2, threshold: 120, comparisonOperator: 'GreaterThanThreshold', treatMissingData: 'notBreaching' });
    new CfnOutput(this, 'ApiEndpoint', { value: api.attrApiEndpoint });
    new CfnOutput(this, 'WorkQueueUrl', { value: queue.ref });
    new CfnOutput(this, 'DlqAlarmName', { value: 'policy-demo-dlq-depth' });
    new CfnOutput(this, 'LambdaErrorAlarmName', { value: 'policy-demo-lambda-error-rate' });
    new CfnOutput(this, 'OutboxAgeAlarmName', { value: 'policy-demo-outbox-lag' });
    new CfnOutput(this, 'ApiUrl', { value: api.attrApiEndpoint });
    new CfnOutput(this, 'ApiInvokeArn', { value: Fn.sub('arn:${AWS::Partition}:execute-api:${AWS::Region}:${AWS::AccountId}:${Api}/*', { Api: api.ref }) });
    for (const name of ['migration', 'publisher', 'worker'] as const) new CfnOutput(this, `${name[0].toUpperCase()}${name.slice(1)}FunctionName`, { value: functions[name].functionName });
    new CfnOutput(this, 'QueueUrl', { value: queue.ref });
    new CfnOutput(this, 'DeadLetterQueueUrl', { value: dlq.ref });
  }
}
