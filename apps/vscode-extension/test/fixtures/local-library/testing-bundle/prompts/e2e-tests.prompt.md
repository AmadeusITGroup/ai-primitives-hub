# Create E2E Tests

Generate end-to-end tests that verify complete user workflows.

## Playwright Example

```javascript
import { test, expect } from '@playwright/test';

test.describe('Login Flow', () => {
  test('should login successfully with valid credentials', async ({ page }) => {
    // Navigate
    await page.goto('https://example.com/login');
    
    // Fill form
    await page.fill('[data-testid="email"]', 'user@example.com');
    await page.fill('[data-testid="password"]', 'password123');
    
    // Submit
    await page.click('[data-testid="login-button"]');
    
    // Verify
    await expect(page).toHaveURL(/dashboard/);
    await expect(page.locator('.welcome-message')).toContainText('Welcome back');
  });
  
  test('should show error with invalid credentials', async ({ page }) => {
    await page.goto('https://example.com/login');
    await page.fill('[data-testid="email"]', 'wrong@example.com');
    await page.fill('[data-testid="password"]', 'wrongpass');
    await page.click('[data-testid="login-button"]');
    
    await expect(page.locator('.error-message')).toBeVisible();
  });
});
```

## Best Practices

- Use data-testid attributes for reliable selectors
- Test critical user journeys
- Handle async operations properly
- Take screenshots on failure
- Run tests in CI/CD
- Test across browsers

## Cypress Example

```javascript
describe('Shopping Cart', () => {
  beforeEach(() => {
    cy.visit('/shop');
  });
  
  it('should add item to cart', () => {
    cy.get('[data-testid="product-1"]').click();
    cy.get('[data-testid="add-to-cart"]').click();
    cy.get('[data-testid="cart-count"]').should('contain', '1');
  });
  
  it('should complete checkout', () => {
    // Add items and checkout
    cy.get('[data-testid="product-1"]').click();
    cy.get('[data-testid="add-to-cart"]').click();
    cy.get('[data-testid="cart"]').click();
    cy.get('[data-testid="checkout"]').click();
    
    // Fill shipping info
    cy.get('#name').type('John Doe');
    cy.get('#address').type('123 Main St');
    
    // Complete order
    cy.get('[data-testid="place-order"]').click();
    cy.url().should('include', '/confirmation');
  });
});
```

Test the complete user experience\!
