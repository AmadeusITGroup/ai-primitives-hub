# Security Policy

## Supported Versions

We actively support the following versions of AI Primitives Hub with security updates:

| Version | Supported          |
| ------- | ------------------ |
| 0.0.x   | :white_check_mark: |

Once we reach 1.0.0, we will follow this policy:

| Version | Supported          |
| ------- | ------------------ |
| 1.x.x   | :white_check_mark: |
| < 1.0   | :x:                |

---

## Reporting a Vulnerability

We take security vulnerabilities seriously. If you discover a security issue, please help us by responsibly disclosing it.

### How to Report

**Please DO NOT open a public GitHub issue for security vulnerabilities.**

Instead, report security issues through one of these channels:

1. **GitHub Security Advisories** (Preferred)
   - Go to the [Security tab](https://github.com/AmadeusITGroup/vscode-prompt-registry/security/advisories) in the repository
   - Click "Report a vulnerability"
   - Fill out the form with details

2. **Private Disclosure**
   - Create a private security advisory
   - Include detailed information about the vulnerability
   - We will respond within 48 hours

### What to Include

Please provide:

- **Type of vulnerability** (e.g., XSS, path traversal, injection)
- **Location** (file, line number, or component)
- **Step-by-step reproduction** (how to trigger the issue)
- **Potential impact** (what can an attacker do?)
- **Suggested fix** (if you have one)
- **Your contact information** (for follow-up questions)

### Example Report

```markdown
**Vulnerability Type**: Path Traversal
**Location**: src/services/BundleInstaller.ts:42
**Severity**: High

**Description**:
The bundle installation function does not properly validate bundle IDs,
allowing path traversal via specially crafted bundle IDs.

**Reproduction**:
1. Install a bundle with ID: `../../etc/passwd`
2. The installer writes files outside the intended directory

**Impact**:
Attackers could write files to arbitrary locations on the file system.

**Suggested Fix**:
Validate bundle IDs against a whitelist of allowed characters:
/^[a-zA-Z0-9-_]+$/
```

---

## Response Process

### Timeline

1. **Acknowledgment**: Within 48 hours
2. **Initial Assessment**: Within 1 week
3. **Fix Development**: Depends on severity
4. **Patch Release**: As soon as fix is tested
5. **Public Disclosure**: After patch is available

### Severity Classification

We use the following severity levels:

| Severity | Description | Response Time |
|----------|-------------|---------------|
| **Critical** | Remote code execution, full system compromise | 24-48 hours |
| **High** | Privilege escalation, data exfiltration | 1 week |
| **Medium** | DoS, limited data exposure | 2-4 weeks |
| **Low** | Minor information disclosure | Next release |

### What to Expect

- **Confirmation**: We'll confirm receipt and assess severity
- **Updates**: Regular updates on fix progress
- **Credit**: Public acknowledgment in release notes (if desired)
- **CVE**: We'll request a CVE for significant vulnerabilities
- **Coordination**: We'll coordinate disclosure timeline with you

---

## Security Best Practices for Users

### For Extension Users

1. **Keep Updated**
   - Enable automatic updates in VS Code
   - Check for updates regularly
   - Review release notes for security fixes

2. **Trust Sources**
   - Only install bundles from trusted sources
   - Review bundle manifests before installation
   - Be cautious with custom HTTP sources

3. **Protect Tokens**
   - Never commit GitHub tokens to version control
   - Use GitHub CLI for authentication when possible
   - Revoke unused tokens

4. **Review Permissions**
   - Understand what the extension can access
   - Check file system operations in logs
   - Monitor installed bundles

### For Bundle Authors

1. **Validate Input**
   - Sanitize all user input in prompts
   - Validate file paths
   - Check data types

2. **Secure Manifests**
   - Use HTTPS URLs only
   - Include integrity hashes
   - Specify exact versions for dependencies

3. **Minimal Permissions**
   - Request only necessary permissions
   - Document why permissions are needed
   - Avoid broad file system access

---

## Known Security Considerations

### WebView Content

The extension uses VS Code WebViews to display the marketplace UI. We implement the following protections:

- **Content Security Policy (CSP)**: Restricts script execution
- **Input Sanitization**: User data is escaped before display
- **Message Validation**: All messages between WebView and extension are validated

### File System Access

Bundle installation involves file system operations:

- **Path Validation**: All paths are normalized and validated
- **Base Directory Restrictions**: Operations limited to extension storage
- **Symlink Handling**: Graceful fallback to copy on failure

### Network Security

The extension makes network requests to registry sources:

- **HTTPS Only**: All GitHub APIs use HTTPS
- **Certificate Validation**: Standard Node.js certificate validation
- **No Credential Storage**: Tokens retrieved from VS Code settings or GitHub CLI

### Authentication

GitHub tokens are handled securely:

- **No Hardcoding**: Tokens never hardcoded in source
- **VS Code Settings**: Stored in user settings (encrypted by VS Code)
- **GitHub CLI**: Uses system keychain when available
- **No Logging**: Tokens never logged or exposed in errors

---

## Security Audit

This project undergoes regular security audits:

- **Last Audit**: November 4, 2025
- **Audit Report**: [SECURITY_AUDIT.md](SECURITY_AUDIT.md)
- **Status**: ✅ Passed

Key findings:
- ✅ No XSS vulnerabilities
- ✅ No path traversal risks
- ✅ No command injection
- ✅ Proper secret management
- ✅ Input validation in place

---

## Dependency Security

We monitor dependencies for vulnerabilities:

- **npm audit**: Run regularly
- **Dependabot**: Enabled for automatic updates
- **Security Advisories**: Monitored via GitHub

To check dependencies:
```bash
npm audit
npm audit fix
```

---

## Security Contact

For security-related questions or concerns:

- **Security Advisories**: Use GitHub Security tab
- **General Questions**: Open a discussion (non-sensitive topics only)
- **Private Concerns**: Use GitHub's private reporting feature

---

## Disclosure Policy

### Coordinated Disclosure

We follow coordinated disclosure:

1. Reporter notifies us privately
2. We confirm and assess the issue
3. We develop and test a fix
4. We release a patch
5. We publicly disclose details (with credit to reporter)

### Disclosure Timeline

- **Critical/High**: 7-14 days after patch
- **Medium**: 30 days after patch
- **Low**: 90 days after patch

We may request more time for complex issues. Reporters will be notified of any delays.

---

## Hall of Fame

We recognize security researchers who responsibly disclose vulnerabilities:

<!-- Security researchers will be listed here -->

*No security reports yet - help us keep it that way!*

---

## Security Updates

Subscribe to security updates:

1. **Watch Repository**: Click "Watch" → "Custom" → "Security alerts"
2. **Release Notes**: Check for security sections in releases
3. **GitHub Advisories**: Follow the Security tab

---

## Legal

### Safe Harbor

We will not pursue legal action against security researchers who:

- Make a good faith effort to follow this policy
- Do not access or modify user data without permission
- Do not exploit vulnerabilities beyond proof-of-concept
- Report vulnerabilities promptly

### Bug Bounty

We do not currently offer a bug bounty program. However, we deeply appreciate security contributions and will publicly credit researchers who help improve our security.

---

## Questions?

If you have questions about this security policy, please:

- Open a GitHub Discussion for general questions
- Use private disclosure for sensitive security concerns
- Check existing security advisories

---

**Last Updated**: November 4, 2025  
**Policy Version**: 1.0

Thank you for helping keep AI Primitives Hub and its users safe! 🔒
