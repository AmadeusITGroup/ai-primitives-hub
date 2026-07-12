# Fix Accessibility Issues

Remediate common accessibility problems with WCAG-compliant solutions.

## Common Issues & Fixes

### Missing Alt Text

```html
<\!-- ❌ Bad -->
<img src="logo.png">

<\!-- ✅ Good - Descriptive alt -->
<img src="logo.png" alt="Company Name Logo">

<\!-- ✅ Good - Decorative image -->
<img src="decoration.png" alt="" role="presentation">
```

### Poor Color Contrast

```css
/* ❌ Bad - 3.2:1 contrast */
.text {
  color: #777;
  background: #fff;
}

/* ✅ Good - 4.7:1 contrast */
.text {
  color: #595959;
  background: #fff;
}
```

### Missing Form Labels

```html
<\!-- ❌ Bad -->
<input type="email" placeholder="Email">

<\!-- ✅ Good - Explicit label -->
<label for="email">Email Address</label>
<input id="email" type="email" required aria-required="true">
```

### Keyboard Navigation

```html
<\!-- ❌ Bad - div as button -->
<div onclick="submit()">Submit</div>

<\!-- ✅ Good - proper button -->
<button type="submit">Submit</button>

<\!-- ✅ Good - keyboard event handlers -->
<div 
  role="button" 
  tabindex="0"
  onclick="submit()"
  onkeypress="handleKeyPress(event)">
  Submit
</div>
```

### Missing Focus Indicators

```css
/* ❌ Bad - removed focus outline */
button:focus {
  outline: none;
}

/* ✅ Good - visible focus -->
button:focus {
  outline: 2px solid #0066cc;
  outline-offset: 2px;
}

/* ✅ Better - custom focus ring */
button:focus-visible {
  box-shadow: 0 0 0 3px rgba(0, 102, 204, 0.5);
}
```

### ARIA Labels

```html
<\!-- ❌ Bad - icon button without label -->
<button><svg>...</svg></button>

<\!-- ✅ Good - aria-label -->
<button aria-label="Close dialog">
  <svg>...</svg>
</button>

<\!-- ✅ Good - visually hidden text -->
<button>
  <svg>...</svg>
  <span class="sr-only">Close dialog</span>
</button>
```

Fix accessibility issues for inclusive design\!
