# TypeScript Best Practices

Apply strict TypeScript standards for type-safe, maintainable code.

You should always follow these TypeScript guidelines:

## Type Safety

- Enable `strict: true` in tsconfig.json
- Avoid `any` type - use `unknown` if truly dynamic
- Define explicit return types for functions
- Use union types instead of enums when appropriate
- Leverage type guards and narrowing

## Interfaces vs Types

- Use `interface` for object shapes
- Use `type` for unions, intersections, primitives
- Prefer composition over complex inheritance

## Best Practices

```typescript
// ✅ Good: Explicit types
interface User {
  id: string;
  name: string;
  email: string;
}

function getUser(id: string): Promise<User> {
  // Implementation
}

// ✅ Good: Union types
type Status = 'pending' | 'success' | 'error';

// ✅ Good: Type guards
function isUser(obj: unknown): obj is User {
  return typeof obj === 'object' && obj \!== null && 'id' in obj;
}

// ❌ Bad: any type
function process(data: any) { }

// ❌ Bad: Implicit any
function getData() {
  return fetch('/api');
}
```

## Generics

Use generics for reusable, type-safe code:

```typescript
function identity<T>(arg: T): T {
  return arg;
}

interface Response<T> {
  data: T;
  error?: string;
}
```

Write type-safe TypeScript code\!
