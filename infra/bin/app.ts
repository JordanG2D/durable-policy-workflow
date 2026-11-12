import { App, CliCredentialsStackSynthesizer, aws_lambda as lambda } from 'aws-cdk-lib';
import { buildSync } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DemoStack } from '../lib/demo-stack.js';
import { BudgetStack } from '../lib/budget-stack.js';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const out = resolve(root, 'infra/.build/handlers');
mkdirSync(out, { recursive: true });
buildSync({ entryPoints: [resolve(root, 'packages/handbuilt/src/aws/handlers.ts')], outfile: resolve(out, 'index.js'), bundle: true, platform: 'node', target: 'node22', format: 'cjs', conditions: ['source'], sourcemap: false, minify: false, external: ['pg-native'] });
if (process.env.CDK_DEFAULT_REGION && process.env.CDK_DEFAULT_REGION !== 'us-east-1') throw new Error('Demo approved only for us-east-1.');
const app = new App();
const synthesizer = () => new CliCredentialsStackSynthesizer({ fileAssetsBucketName: process.env.AWS_ASSET_BUCKET ?? process.env.POLICY_ASSET_BUCKET ?? 'policy-demo-assets-${AWS::AccountId}-${AWS::Region}', bucketPrefix: 'policy-demo/' });
new DemoStack(app, 'PolicyDemo', { code: lambda.Code.fromAsset(out), synthesizer: synthesizer(), runtimeBoundaryArn: process.env.POLICY_RUNTIME_BOUNDARY_ARN, analyticsReporting: false });
// Existing console budget may be reused. Only opt in after an additional budget is approved.
if (process.env.POLICY_CREATE_BUDGET === 'true') new BudgetStack(app, 'PolicyDemoBudget', { synthesizer: synthesizer(), analyticsReporting: false });
app.synth();
