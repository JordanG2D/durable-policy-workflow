/** Raw stdout preserves top-level EMF under Lambda JSON LoggingConfig.
 * console.log would wrap the document in a message field. */
export function emitOutboxLag(seconds: number): void {
  process.stdout.write(JSON.stringify({ _aws: { Timestamp: Date.now(), CloudWatchMetrics: [{
    Namespace: "PolicyDemo", Dimensions: [["Service"]], Metrics: [{ Name: "OutboxLagSeconds", Unit: "Seconds" }],
  }] }, Service: "handbuilt", OutboxLagSeconds: Number.isFinite(seconds) ? Math.max(0, seconds) : 0 }) + "\n");
}
