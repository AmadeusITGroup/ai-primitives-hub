# Write Unit Tests

Generate comprehensive unit tests following TDD principles and best practices.

## Test Structure (AAA Pattern)

```javascript
describe('ComponentName', () => {
  // Arrange - Setup
  beforeEach(() => {
    // Setup code
  });
  
  it('should do something specific', () => {
    // Arrange - Prepare test data
    const input = { value: 'test' };
    
    // Act - Execute function
    const result = functionUnderTest(input);
    
    // Assert - Verify result
    expect(result).toBe(expected);
  });
});
```

## What to Test

1. **Happy Path**: Normal, expected usage
2. **Edge Cases**: Boundary conditions, empty inputs
3. **Error Cases**: Invalid inputs, exceptions
4. **Side Effects**: State changes, API calls
5. **Integration Points**: Mocked dependencies

## Jest Example

```javascript
import { calculateTotal } from './calculator';

describe('calculateTotal', () => {
  it('should sum positive numbers', () => {
    expect(calculateTotal([1, 2, 3])).toBe(6);
  });
  
  it('should handle empty array', () => {
    expect(calculateTotal([])).toBe(0);
  });
  
  it('should throw on invalid input', () => {
    expect(() => calculateTotal(null)).toThrow('Invalid input');
  });
  
  it('should handle negative numbers', () => {
    expect(calculateTotal([1, -2, 3])).toBe(2);
  });
});
```

## Mocking Dependencies

```javascript
jest.mock('./api');

it('should fetch user data', async () => {
  const mockUser = { id: 1, name: 'Test' };
  api.getUser.mockResolvedValue(mockUser);
  
  const result = await fetchUserData(1);
  
  expect(api.getUser).toHaveBeenCalledWith(1);
  expect(result).toEqual(mockUser);
});
```

Write tests that give confidence\!
