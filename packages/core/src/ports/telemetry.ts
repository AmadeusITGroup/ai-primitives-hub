/**
 * Telemetry port interfaces.
 *
 * Defines the contract for telemetry documents and transports.
 * Implementations in `@ai-primitives-hub/infra` handle delivery to
 * specific backends (Elasticsearch, console, etc.).
 * @module ports/telemetry
 */

export interface TelemetryDocument {
  timestamp: string;
  eventName?: string;
  error?: { message: string; stack?: string };
  data?: Record<string, unknown>;
}

export interface TelemetryTransport {
  send(doc: TelemetryDocument): void;
  dispose(): void;
}
