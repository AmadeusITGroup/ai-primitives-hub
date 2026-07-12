# Add Accessibility Features

Enhance web applications with comprehensive accessibility features following WCAG 2.1 AA standards.

## Objectives

1. Add proper ARIA labels and roles
2. Ensure keyboard navigation
3. Provide alternative text for images
4. Implement focus management
5. Test with screen readers

## Key Areas

- **Semantic HTML**: Use proper heading hierarchy, landmarks
- **ARIA**: Add aria-label, aria-describedby when needed
- **Keyboard**: Ensure all interactive elements are keyboard accessible
- **Focus**: Visible focus indicators, logical tab order
- **Color Contrast**: WCAG AA minimum (4.5:1 for text)
- **Alt Text**: Descriptive alternatives for images

## Common Fixes

```html
<\!-- Add skip link -->
<a href="#main-content" class="skip-link">Skip to main content</a>

<\!-- Proper button vs link -->
<button onclick="doAction()">Action</button>
<a href="/page">Navigate</a>

<\!-- Form labels -->
<label for="email">Email</label>
<input id="email" type="email" aria-required="true">

<\!-- Focus management -->
<div role="dialog" aria-labelledby="dialog-title">
  <h2 id="dialog-title">Dialog Title</h2>
</div>
```

Make web apps accessible to everyone\!
