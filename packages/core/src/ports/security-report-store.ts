/** Port for security-report persistence with infrastructure-enforced safety. */

export interface SecurityReportStore {
  write(request: {
    destination: string;
    contents: string;
    overwrite: 'never' | 'replace';
  }): Promise<void>;
}
