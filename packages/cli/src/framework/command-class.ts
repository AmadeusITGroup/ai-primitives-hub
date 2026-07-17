/**
 * Utility for configuring native Clipanion command subclasses.
 *
 * The `copyCommandPrototype` helper ensures that Clipanion's option
 * metadata (discovered via prototype property descriptors) is visible on
 * the dynamically-created `ConfiguredCommand` subclass. Without this,
 * Clipanion only sees options declared on the concrete subclass itself
 * rather than inheriting them from the base class's prototype.
 * @module framework/command-class
 */

/**
 * Copy all non-constructor property descriptors from a base command class to
 * a subclass prototype so that Clipanion discovers the inherited options and
 * the static `usage` shape.
 * @param baseClass - The original command class whose options to inherit.
 * @param subClass - The dynamically-created subclass to configure.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type -- generic class reference
export const copyCommandPrototype = (baseClass: Function, subClass: Function): void => {
  // Copy prototype descriptors (methods, getters, setters).
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- dynamic prototype access
  const baseDescriptors = Object.getOwnPropertyDescriptors((baseClass as any).prototype);
  for (const [key, descriptor] of Object.entries(baseDescriptors)) {
    if (key !== 'constructor') {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- dynamic prototype access
      Object.defineProperty((subClass as any).prototype, key, descriptor);
    }
  }

  // Copy class fields (own properties on a base instance) so inherited
  // clipanion options and other field declarations are visible on the
  // subclass instances.
  const baseInstance = new (baseClass as unknown as new () => object)();
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(baseInstance))) {
    if (key !== 'constructor') {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- dynamic prototype access
      Object.defineProperty((subClass as any).prototype, key, descriptor);
    }
  }

  // Copy static clipanion metadata (paths / usage) to the subclass.
  const staticBase = baseClass as unknown as { paths?: unknown; usage?: unknown };
  const staticSub = subClass as unknown as { paths?: unknown; usage?: unknown };
  staticSub.paths = staticBase.paths;
  staticSub.usage = staticBase.usage;
};
