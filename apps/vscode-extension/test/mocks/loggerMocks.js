/**
 * Logger Mocks for Testing
 * Provides mock logger to avoid VS Code channel disposal errors
 */

/**
 * Mock Logger that doesn't depend on VS Code output channels
 */
class MockLogger {
  constructor() {
    this.logs = [];
  }

  info(message, ...args) {
    this.logs.push({ level: 'info', message, args, timestamp: new Date() });
  }

  warn(message, ...args) {
    this.logs.push({ level: 'warn', message, args, timestamp: new Date() });
  }

  error(message, ...args) {
    this.logs.push({ level: 'error', message, args, timestamp: new Date() });
  }

  debug(message, ...args) {
    this.logs.push({ level: 'debug', message, args, timestamp: new Date() });
  }

  // Test utility methods
  getLogs(level = null) {
    return level ? this.logs.filter((log) => log.level === level) : this.logs;
  }

  getLastLog(level = null) {
    const logs = this.getLogs(level);
    return logs.at(-1);
  }

  clearLogs() {
    this.logs = [];
  }

  hasLogged(level, messagePattern) {
    return this.logs.some((log) =>
      log.level === level
      && (typeof messagePattern === 'string'
        ? log.message.includes(messagePattern)
        : messagePattern.test(log.message))
    );
  }
}

module.exports = {
  MockLogger
};
