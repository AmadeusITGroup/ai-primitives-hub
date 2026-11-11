/**
 * Object and ordering helpers shared by every install record reader and writer.
 * @module domain/install/record-object
 */

/**
 * Whether a value is a JSON object: not `null` and not an array.
 * @param value - Any value.
 */
export const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Locale-independent code-unit order, used for every sorted key and path in a record.
 * @param left - First text.
 * @param right - Second text.
 */
export const compareCodeUnits = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
};

/**
 * Shallow copy of an object's own string keys into a `null`-prototype object.
 * @param value - Object to copy.
 */
export const nullPrototypeCopy = <T extends object>(value: T): T => {
  const copy = Object.create(null) as T;
  for (const key of Object.keys(value) as (keyof T & string)[]) {
    copy[key] = value[key];
  }
  return copy;
};
