# WCAG Compliance Standards

Automatically apply WCAG 2.1 Level AA standards to all code.

## Always Implement

### Semantic HTML
- Use proper heading hierarchy (h1 → h6)
- Use semantic elements (nav, main, article, section)
- Use landmarks (role="navigation", role="main")

### Keyboard Accessibility
- All interactive elements must be keyboard accessible
- Provide visible focus indicators
- Logical tab order
- Skip navigation links

### Color & Contrast
- 4.5:1 minimum for normal text
- 3:1 minimum for large text (18pt+)
- Don't rely on color alone for information
- Provide text alternatives

### Forms
- All inputs must have associated labels
- Required fields marked with aria-required
- Error messages linked with aria-describedby
- Group related fields with fieldset/legend

## Code Templates

```html
<\!-- Form with labels and error messages -->
<form>
  <div class="form-group">
    <label for="email">
      Email Address <span aria-label="required">*</span>
    </label>
    <input 
      id="email" 
      type="email" 
      aria-required="true"
      aria-describedby="email-error"
      aria-invalid="false">
    <div id="email-error" class="error" role="alert"></div>
  </div>
</form>

<\!-- Custom component with ARIA -->
<div 
  role="tablist" 
  aria-label="Content sections">
  <button 
    role="tab" 
    aria-selected="true" 
    aria-controls="panel1"
    id="tab1">
    Tab 1
  </button>
  <div 
    role="tabpanel" 
    id="panel1" 
    aria-labelledby="tab1">
    Panel content
  </div>
</div>

<\!-- Focus management -->
<style>
  .skip-link {
    position: absolute;
    top: -40px;
    left: 0;
    background: #000;
    color: #fff;
    padding: 8px;
  }
  
  .skip-link:focus {
    top: 0;
  }
  
  *:focus-visible {
    outline: 2px solid #0066cc;
    outline-offset: 2px;
  }
</style>
```

## Testing Requirements

- Test with keyboard only
- Test with screen reader
- Validate with axe DevTools
- Check color contrast
- Verify heading hierarchy

Build accessible applications from the start\!
