---
name: TypeScript Project Guidelines
description: Coding standards and best practices for TypeScript projects
applyTo: "**/*.ts"
---

# TypeScript Project Coding Standards

## General Principles

Follow these principles when writing TypeScript code:

- **Clarity**: Write self-documenting code with clear variable and function names
- **Type Safety**: Leverage TypeScript's type system to catch errors early
- **Consistency**: Follow established patterns throughout the codebase
- **Simplicity**: Keep functions focused and single-purpose
- **Documentation**: Document public APIs with JSDoc comments

## Code Style

### TypeScript/JavaScript Best Practices

- Use `const` by default, `let` if reassignment is needed (never `var`)
- Use arrow functions for callbacks: `(param) => { }`
- Use template literals for string interpolation
- Prefer interfaces over type aliases for object shapes
- Use enums sparingly; consider string unions instead

### Function Guidelines

```typescript
/**
 * Calculate total price including tax
 * @param price - Base price in dollars
 * @param taxRate - Tax rate as decimal (0.1 = 10%)
 * @returns Total price with tax applied
 */
function calculateTotal(price: number, taxRate: number): number {
  return price * (1 + taxRate);
}
```

### Error Handling

- Always handle errors gracefully with try-catch where appropriate
- Throw meaningful error messages with context
- Use custom error classes for domain-specific errors
- Log errors with sufficient context for debugging

### Testing

- Write unit tests for all business logic
- Test both happy path and error cases
- Maintain test coverage above 80%
- Use descriptive test names that explain the scenario

## File Organization

- One logical concept per file
- Keep files under 300 lines when possible
- Group related functionality in directories
- Use clear, descriptive file names (kebab-case for files)

## Git Conventions

Use conventional commit messages:
```
feat: add user authentication
fix: resolve memory leak in cache
docs: update API documentation
test: add edge case tests
refactor: simplify validation logic
```

## Code Review Focus

During review, prioritize:
1. Logic correctness and edge cases
2. Type safety and null checks
3. Test coverage and clarity
4. Documentation accuracy
5. Performance implications
