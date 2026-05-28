/**
 * Type guards for configuration values
 * Provides runtime validation for VS Code configuration settings
 */

/**
 * Valid values for update check frequency setting
 */
export type UpdateCheckFrequency = 'daily' | 'weekly' | 'manual';

/**
 * Valid values for notification preference setting
 */
export type NotificationPreference = 'all' | 'critical' | 'none';

/**
 * Type guard to check if a value is a valid UpdateCheckFrequency
 * @param value - The value to check
 * @returns True if the value is a valid UpdateCheckFrequency
 */
export function isValidUpdateCheckFrequency(value: unknown): value is UpdateCheckFrequency {
  return (
    typeof value === 'string'
    && (value === 'daily' || value === 'weekly' || value === 'manual')
  );
}

/**
 * Type guard to check if a value is a valid NotificationPreference
 * @param value - The value to check
 * @returns True if the value is a valid NotificationPreference
 */
export function isValidNotificationPreference(value: unknown): value is NotificationPreference {
  return (
    typeof value === 'string'
    && (value === 'all' || value === 'critical' || value === 'none')
  );
}

/**
 * Get a valid UpdateCheckFrequency with fallback to default
 * @param value - The value to validate
 * @param defaultValue - The default value to use if validation fails (default: 'daily')
 * @returns A valid UpdateCheckFrequency
 */
export function getValidUpdateCheckFrequency(
    value: unknown,
    defaultValue: UpdateCheckFrequency = 'daily'
): UpdateCheckFrequency {
  if (isValidUpdateCheckFrequency(value)) {
    return value;
  }
  return defaultValue;
}

/**
 * Get a valid NotificationPreference with fallback to default
 * @param value - The value to validate
 * @param defaultValue - The default value to use if validation fails (default: 'all')
 * @returns A valid NotificationPreference
 */
export function getValidNotificationPreference(
    value: unknown,
    defaultValue: NotificationPreference = 'all'
): NotificationPreference {
  if (isValidNotificationPreference(value)) {
    return value;
  }
  return defaultValue;
}
