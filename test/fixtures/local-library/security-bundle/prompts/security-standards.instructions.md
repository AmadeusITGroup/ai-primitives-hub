# Secure Coding Standards

Always apply these security best practices to all code:

## Input Validation
- Validate and sanitize ALL user input
- Use allowlists over denylists
- Implement proper data type checking
- Limit input length and format

## Authentication & Sessions
- Use strong password hashing (bcrypt, Argon2)
- Implement secure session management
- Use HTTPS for all authenticated routes
- Add CSRF protection
- Implement rate limiting

## Data Protection
- Never store passwords in plain text
- Encrypt sensitive data at rest
- Use HTTPS for data in transit
- Sanitize data before database queries
- Use parameterized queries

## Error Handling
- Don't expose stack traces to users
- Log security events
- Use generic error messages
- Implement proper exception handling

## Dependencies
- Keep dependencies updated
- Audit packages for vulnerabilities
- Use tools like npm audit, Snyk
- Pin dependency versions

## Code Examples

```javascript
// ✅ Always validate input
function processUserData(data) {
  if (typeof data \!== 'object') {
    throw new ValidationError('Invalid input');
  }
  // Continue processing
}

// ✅ Use environment variables for secrets
const config = {
  dbPassword: process.env.DB_PASSWORD,
  apiKey: process.env.API_KEY
};

// ✅ Implement rate limiting
const rateLimit = require('express-rate-limit');
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100
});
app.use('/api/', limiter);
```

Security is not optional - build it in from the start\!
