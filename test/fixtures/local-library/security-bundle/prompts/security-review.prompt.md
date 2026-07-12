# Security Code Review

Perform comprehensive security analysis following OWASP Top 10 and security best practices.

## Review Checklist

### 1. Injection Vulnerabilities
- SQL injection
- Command injection
- LDAP injection
- XSS (Cross-Site Scripting)

### 2. Authentication & Authorization
- Weak password policies
- Insecure session management
- Missing authentication checks
- Broken access control

### 3. Sensitive Data Exposure
- Hardcoded secrets
- Unencrypted sensitive data
- Exposed API keys
- Insecure data transmission

### 4. Security Misconfiguration
- Default credentials
- Unnecessary services enabled
- Verbose error messages
- Missing security headers

### 5. Input Validation
- Missing input sanitization
- Improper data validation
- File upload vulnerabilities

## Review Format

```markdown
## Security Findings

### 🔴 Critical Issues
1. **SQL Injection** (Line 45)
   - **Risk**: Allows arbitrary database queries
   - **Fix**: Use parameterized queries
   
### 🟡 Medium Issues
2. **Hardcoded API Key** (Line 12)
   - **Risk**: Credentials exposed in source code
   - **Fix**: Use environment variables

### 🟢 Recommendations
3. Add rate limiting to API endpoints
4. Implement CSRF protection
```

Identify and fix security vulnerabilities\!
