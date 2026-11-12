import { createHash, createHmac, randomUUID } from 'node:crypto';
import { URL } from 'node:url';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { SQSClient, SendMessageCommand, ReceiveMessageCommand, DeleteMessageCommand } from '@aws-sdk/client-sqs';
import { CloudWatchClient, DescribeAlarmsCommand } from '@aws-sdk/client-cloudwatch';
import { outputs, region, poll, reportError } from './common.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();
// IAM-authorized HTTP API requests. Credentials remain only in memory.
async function request(base, path, method, payload, idempotencyKey) {
  const credentials = await defaultProvider()();
  const url = new URL(path, base);
  const body = payload === undefined ? '' : JSON.stringify(payload);
  const timestamp = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = timestamp.slice(0, 8);
  const headers = { host: url.host, 'x-amz-date': timestamp, 'x-amz-content-sha256': hash(body) };
  if (credentials.sessionToken) headers['x-amz-security-token'] = credentials.sessionToken;
  if (body) headers['content-type'] = 'application/json';
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(';');
  const canonical = [method, url.pathname, '', names.map(key => `${key}:${headers[key]}\n`).join(''), signedHeaders, hash(body)].join('\n');
  const scope = `${date}/${region}/execute-api/aws4_request`;
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, date), region), 'execute-api'), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(`AWS4-HMAC-SHA256\n${timestamp}\n${scope}\n${hash(canonical)}`).digest('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const response = await fetch(url, { method, headers, body: body || undefined, signal: globalThis.AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Smoke HTTP request failed with status ${response.status}.`);
  return { body: await response.json(), replayed: response.headers.get('idempotent-replayed'), status: response.status };
}

async function main() {
  const out = await outputs();
  const api = out.ApiUrl;
  const queue = out.QueueUrl;
  const dlq = out.DeadLetterQueueUrl;
  if (!api || !queue || !dlq) throw new Error('Missing smoke stack outputs.');
  const token = `demo-smoke-${randomUUID()}`;
  const payload = { businessName: 'AWS synthetic demo', industry: 'retail', annualRevenueCents: 85000000, employeeCount: 6, contactEmail: 'smoke@example.invalid' };
  const created = await request(api, '/v1/policy-applications', 'POST', payload, token);
  if (created.status !== 202 || !created.body.workflowId) throw new Error('Policy create did not return an accepted workflow.');
  const path = `/v1/policy-applications/${encodeURIComponent(created.body.workflowId)}`;
  const completed = await poll('Policy completion', async () => (await request(api, path, 'GET')).body, value => {
    if (value.state === 'DEAD_LETTERED') throw new Error('Synthetic policy unexpectedly dead-lettered.');
    return value.state === 'DOCUMENTS_DELIVERED';
  }, { timeoutMs: 900_000, intervalMs: 10_000 });
  if (!String(completed.paymentChargeId).startsWith('demo-payment-') || !String(completed.documentDeliveryId).startsWith('demo-document-')) throw new Error('Expected synthetic-only effects.');
  const replay = await request(api, '/v1/policy-applications', 'POST', payload, token);
  if (replay.replayed !== 'true' || JSON.stringify(replay.body) !== JSON.stringify(created.body)) throw new Error('Idempotent replay did not return the original response.');
  const afterReplay = (await request(api, path, 'GET')).body;
  if (afterReplay.paymentChargeId !== completed.paymentChargeId || afterReplay.documentDeliveryId !== completed.documentDeliveryId || afterReplay.state !== completed.state || JSON.stringify(afterReplay.transitions) !== JSON.stringify(completed.transitions)) throw new Error('Replay changed durable policy effects or transitions.');
  console.log('Synthetic policy delivered; replay preserved effects and transitions.');
  const sqs = new SQSClient({ region });
  const poison = JSON.stringify({ version: 1, kind: 'poison', testId: token });
  await sqs.send(new SendMessageCommand({ QueueUrl: queue, MessageBody: poison }));
  const received = await poll('Native SQS dead-letter redrive', async () => {
    const response = await sqs.send(new ReceiveMessageCommand({ QueueUrl: dlq, MaxNumberOfMessages: 10, WaitTimeSeconds: 10, VisibilityTimeout: 1 }));
    return response.Messages?.find(x => x.Body === poison);
  }, Boolean, { timeoutMs: 900_000, intervalMs: 5_000 });
  const names = [out.DlqAlarmName, out.LambdaErrorAlarmName, out.OutboxAgeAlarmName];
  if (names.some(x => !x)) throw new Error('Missing required alarm outputs.');
  const cw = new CloudWatchClient({ region });
  await poll('DLQ alarm', async () => (await cw.send(new DescribeAlarmsCommand({ AlarmNames: names }))).MetricAlarms || [], alarms => alarms.length === names.length && alarms.some(x => x.AlarmName === out.DlqAlarmName && x.StateValue === 'ALARM'), { timeoutMs: 600_000, intervalMs: 15_000 });
  // Remove only the unique synthetic message after observing its native redrive and alarm.
  const current = await poll('Smoke poison receipt', async () => (await sqs.send(new ReceiveMessageCommand({ QueueUrl: dlq, MaxNumberOfMessages: 10, WaitTimeSeconds: 5 }))).Messages?.find(x => x.Body === poison), Boolean, { timeoutMs: 60_000, intervalMs: 1_000 });
  if (!received.MessageId || current.MessageId !== received.MessageId) throw new Error('Unexpected DLQ smoke message.');
  await sqs.send(new DeleteMessageCommand({ QueueUrl: dlq, ReceiptHandle: current.ReceiptHandle }));
  console.log('Malformed event reached native SQS DLQ; all alarms exist and DLQ alarm entered ALARM.');
}
main().catch(reportError);
