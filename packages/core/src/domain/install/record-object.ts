/**
 * Object and ordering primitives shared by every install record reader and
 * writer (BR1.11, NFR4.4).
 *
 * The canonical record bytes depend on every writer sorting with the same
 * comparator, and records are held in prototype-free objects, so these live
 * in one place instead of being re-declared per file.
 * @module domain/install/record-object
 */

/**
 * Whether a value is a JSON object: not `null` and not an array.
 * @param value - Any value.
 * @returns Whether `value` can be read as a string-keyed object.
 */
export const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Code-unit order, independent of locale: the order the canonical record
 * serializer sorts keys and paths in (BR1.11).
 * @param left - First text.
 * @param right - Second text.
 * @returns A negative number, zero or a positive number, as for `Array.prototype.sort`.
 */
export const compareCodeUnits = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
};

/**
 * Shallow copy of an object's own enumerable string keys into an object with
 * a `null` prototype (NFR4.4).
 * @param value - Object to copy; left unchanged.
 * @returns The copy.
 */
export const nullPrototypeCopy = <T extends object>(value: T): T => {
  const copy = Object.create(null) as T;
  for (const key of Object.keys(value) as (keyof T & string)[]) {
    copy[key] = value[key];
  }
  return copy;
};
