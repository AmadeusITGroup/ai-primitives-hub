export interface TelemetryDocument {
  timestamp: string;
  eventName?: string;
  error?: { message: string; stack?: string };
  data?: Record<string, any>;
}

/**
 * Transport layer for telemetry documents.
 * Implementations handle delivery to a specific backend (e.g. Elastic Search).
 */
export interface TelemetryTransport {
  /**
   * Send a telemetry document to the backend.
   * @param doc - the telemetry document to send
   */
  send(doc: TelemetryDocument): void;

  /**
   * Release resources held by the transport.
   */
  dispose(): void;
}
