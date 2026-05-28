# Improve Test Coverage

Systematically analyze and improve test coverage for better quality assurance.

## Coverage Analysis

```bash
# Generate coverage report
npm test -- --coverage

# Key metrics:
# - Statements: % of code statements executed
# - Branches: % of if/else branches tested
# - Functions: % of functions called
# - Lines: % of code lines executed
```

## Priority Areas

1. **Critical Paths**: Authentication, payments, data manipulation
2. **Complex Logic**: Algorithms, calculations, state machines
3. **Error Handling**: Exception paths, edge cases
4. **Public APIs**: Exported functions and classes

## Strategy

```javascript
// Identify untested branches
function processPayment(amount, method) {
  if (amount <= 0) {
    throw new Error('Invalid amount'); // ⚠️ Test this
  }
  
  if (method === 'credit') {
    return processCreditCard(amount);  // ⚠️ Test this
  } else if (method === 'debit') {
    return processDebit(amount);       // ⚠️ Test this
  } else {
    throw new Error('Invalid method'); // ⚠️ Test this
  }
}

// Add tests for each branch
describe('processPayment', () => {
  it('should throw on negative amount', () => {
    expect(() => processPayment(-10, 'credit')).toThrow('Invalid amount');
  });
  
  it('should process credit card payment', () => {
    const result = processPayment(100, 'credit');
    expect(result.method).toBe('credit');
  });
  
  it('should process debit payment', () => {
    const result = processPayment(100, 'debit');
    expect(result.method).toBe('debit');
  });
  
  it('should throw on invalid method', () => {
    expect(() => processPayment(100, 'invalid')).toThrow('Invalid method');
  });
});
```

## Coverage Goals

- **80%+ overall**: Industry standard
- **90%+ critical**: Payment, auth, data
- **100% public APIs**: All exports tested

Achieve comprehensive test coverage\!
