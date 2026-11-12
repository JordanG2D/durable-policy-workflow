import { DeleteStackCommand, ListStackResourcesCommand } from '@aws-sdk/client-cloudformation';
import { LambdaClient, ListEventSourceMappingsCommand } from '@aws-sdk/client-lambda';
import { assertScope, awsRead, cfn, poll, readStack, region, stackName } from './common.mjs';

const logicalId = 'WorkerMessages';
const resourceType = 'AWS::Lambda::EventSourceMapping';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function refuse(reason) {
  const error = new Error(`Guarded cleanup recovery refused: ${reason}.`);
  error.name = 'CleanupRecoveryError';
  throw error;
}
function owned(stack) {
  if (stack?.StackName !== 'PolicyDemo' || stackName !== 'PolicyDemo' ||
      typeof stack.StackId !== 'string' || !stack.StackId ||
      !Array.isArray(stack.Tags) ||
      stack.Tags?.filter(t => t.Key === 'Project').length !== 1 ||
      stack.Tags.find(t => t.Key === 'Project')?.Value !== 'PolicyDemo')
    refuse('stack identity or ownership did not match');
}
async function completeList(client, Command, input, field, inputToken, outputToken) {
  const records = [];
  const seen = new Set();
  let token;
  for (let page = 0; page < 1000; page++) {
    const response = await awsRead(client, new Command({ ...input, ...(token ? { [inputToken]: token } : {}) }));
    if (!response || !Array.isArray(response[field])) refuse('inventory response was incomplete');
    records.push(...response[field]);
    const next = response[outputToken];
    if (next === undefined || next === '') return records;
    if (typeof next !== 'string' || seen.has(next)) refuse('inventory pagination was invalid');
    seen.add(next);
    token = next;
  }
  refuse('inventory pagination exceeded its bound');
}
async function retainOnlyMissingMapping(stack, role) {
  owned(stack);
  if (stack.StackStatus !== 'DELETE_FAILED') refuse('stack is not in failed deletion');
  const resources = await completeList(cfn(), ListStackResourcesCommand, { StackName: stack.StackId }, 'StackResourceSummaries', 'NextToken', 'NextToken');
  if (resources.some(r => !r || typeof r.LogicalResourceId !== 'string' || typeof r.ResourceType !== 'string' || typeof r.ResourceStatus !== 'string')) refuse('stack resource inventory was incomplete');
  const matches = resources.filter(r => r.LogicalResourceId === logicalId);
  if (matches.length !== 1 || matches[0].ResourceType !== resourceType || matches[0].ResourceStatus !== 'DELETE_FAILED' || !uuidPattern.test(matches[0].PhysicalResourceId || ''))
    refuse('failed mapping record did not exactly match');
  if (resources.some(r => r.ResourceStatus === 'DELETE_FAILED' && r.LogicalResourceId !== logicalId)) refuse('another resource also failed deletion');
  const mappings = await completeList(new LambdaClient({ region }), ListEventSourceMappingsCommand, {}, 'EventSourceMappings', 'Marker', 'NextMarker');
  if (mappings.some(m => !m || typeof m.UUID !== 'string' || !uuidPattern.test(m.UUID))) refuse('mapping inventory was incomplete');
  if (mappings.some(m => m.UUID.toLowerCase() === matches[0].PhysicalResourceId.toLowerCase())) refuse('the failed mapping still exists');
  // Recheck the pinned stack after inventory, not a replacement with the same name.
  const current = await readStack(stack.StackId);
  owned(current);
  if (current.StackId !== stack.StackId || current.StackStatus !== 'DELETE_FAILED') refuse('stack changed during verification');
  console.log('Guarded cleanup verified the sole failed mapping is absent from the complete Lambda inventory; skipping only its stale CloudFormation record.');
  await cfn().send(new DeleteStackCommand({ StackName: stack.StackId, RoleARN: role, RetainResources: [logicalId] }));
}
async function terminal(id) {
  const stack = await poll('Runtime destruction', () => readStack(id), current => !current || ['DELETE_FAILED', 'DELETE_COMPLETE'].includes(current.StackStatus), { timeoutMs: 2_400_000 });
  // DescribeStacks by pinned stack ID can return DELETE_COMPLETE after name lookup
  // stops finding the stack. Full residual inventory is still required by caller.
  return stack?.StackStatus === 'DELETE_COMPLETE' ? undefined : stack;
}
export async function deleteRuntimeStack(role) {
  assertScope();
  let stack = await readStack();
  if (!stack) return;
  owned(stack);
  if (/_IN_PROGRESS$/.test(stack.StackStatus)) {
    stack = await poll('Pending stack operation', () => readStack(stack.StackId), current => !current || !/_IN_PROGRESS$/.test(current.StackStatus), { timeoutMs: 2_400_000 });
    if (!stack || stack.StackStatus === 'DELETE_COMPLETE') return;
    owned(stack);
  }
  if (stack.StackStatus !== 'DELETE_FAILED') {
    await cfn().send(new DeleteStackCommand({ StackName: stack.StackId, RoleARN: role }));
    stack = await terminal(stack.StackId);
    if (!stack) return;
  }
  // At most one guarded recovery attempt, whether failure predated this run or
  // arose from the normal deletion above. Never relax permissions or retain live data.
  await retainOnlyMissingMapping(stack, role);
  if (await terminal(stack.StackId)) refuse('the single guarded retry did not complete deletion');
  // Caller must still perform the full residual-resource and asset verification.
}
