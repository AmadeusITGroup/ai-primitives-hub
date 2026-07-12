# TDD Best Practices

Follow Test-Driven Development principles: Write tests first, then implement.

## TDD Cycle (Red-Green-Refactor)

1. **Red**: Write a failing test
2. **Green**: Write minimal code to pass
3. **Refactor**: Improve code while tests pass

## Always Follow

- Write test before implementation
- Test one thing at a time
- Use descriptive test names
- Keep tests independent
- Make tests fast
- Mock external dependencies

## Test Structure

```javascript
// ✅ Good: Descriptive, focused
describe('User Service', () => {
  describe('createUser', () => {
    it('should create user with valid data', async () => {
      const userData = { email: 'test@example.com', name: 'Test' };
      const user = await userService.createUser(userData);
      expect(user).toHaveProperty('id');
      expect(user.email).toBe(userData.email);
    });
    
    it('should throw error when email is invalid', async () => {
      const userData = { email: 'invalid', name: 'Test' };
      await expect(userService.createUser(userData))
        .rejects.toThrow('Invalid email');
    });
  });
});

// ❌ Bad: Vague, multiple assertions
it('should work', async () => {
  const user = await createUser({ email: 'test@example.com' });
  expect(user).toBeDefined();
  expect(user.name).toBe('Test');
  const updated = await updateUser(user.id, { name: 'New' });
  expect(updated.name).toBe('New');
});
```

## Test Coverage

- Aim for 80%+ coverage minimum
- 100% coverage for critical paths
- Test edge cases and error conditions
- Don't sacrifice quality for coverage percentage

Write tests first, code second\!
