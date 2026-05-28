# Security Policy for {{projectName}}

## 🛡️ Security

We take the security of {{projectName}} seriously. This document outlines our security practices and how to report vulnerabilities.

## Supported Versions

| Version | Supported | Security Updates |
|---------|-----------|------------------|
| Current main branch | ✅ Yes | ✅ Yes |
| Latest tagged release | ✅ Yes | ✅ Yes |
| Older versions | ❌ No | ❌ No |

## 🐛 Reporting a Vulnerability

### **DO NOT** report security vulnerabilities publicly

Public disclosure can put users at risk. Please follow our responsible disclosure process.

### How to Report

**Primary Method**: Email us at {{internalContact}}

**What to Include**:
- **Description** of the vulnerability
- **Steps to reproduce** the issue
- **Potential impact** of the vulnerability
- **Proof of concept** (if available)
- **Your contact information** (for follow-up questions)

**Email Subject**: `Security: {{projectName}} - [Brief Description]`

### Response Timeline

- **Acknowledgment**: Within 1 business day
- **Initial Assessment**: Within 3 business days  
- **Detailed Response**: Within 7 business days
- **Patch Release**: As soon as feasible, based on severity

## 🔒 Security Best Practices

### For Users

- **Keep dependencies updated**: Run `npm update` regularly
- **Review content**: Understand what prompts/instructions do before using
- **Use trusted sources**: Only install collections from trusted repositories
- **Report suspicious content**: If you notice harmful prompts, report them

### For Contributors

- **Validate all inputs**: Use provided validation scripts
- **Avoid sensitive data**: Don't include passwords, API keys, or secrets
- **Review dependencies**: Check for known vulnerabilities in dependencies
- **Follow secure coding practices**: Use established security patterns

### Common Security Considerations

#### Prompt Injection Risks
- **Input validation**: Be aware of potential prompt injection scenarios
- **Output filtering**: Consider what your prompts might generate
- **Context isolation**: Understand how prompts interact with user input

#### Code Generation Risks  
- **Code review**: Review generated code for security issues
- **Testing**: Test generated code in safe environments first
- **Validation**: Validate generated code before use

#### Data Privacy
- **No personal data**: Don't include personal or sensitive information in prompts
- **Compliance**: Follow relevant data protection regulations
- **Minimal data**: Use only necessary data in prompts

## 🛠️ Security Features

### Built-in Protections

- **Input validation**: All YAML and markdown files are validated
- **Schema validation**: JSON schemas enforce structure constraints
- **Content scanning**: Automated checks for common security issues
- **Access control**: Repository permissions control who can modify content

### Dependency Management

- **Regular updates**: Dependencies are updated regularly
- **Vulnerability scanning**: Automated scanning for known vulnerabilities  
- **Minimal dependencies**: We limit dependencies to reduce attack surface
- **Source verification**: Dependencies are sourced from trusted repositories

## 📋 Security Checklist

### Before Publishing Content

- [ ] No sensitive information (passwords, keys, personal data)
- [ ] No malicious or harmful instructions
- [ ] Code examples are safe and follow best practices
- [ ] External links are to trusted sources
- [ ] Dependencies are secure and up-to-date

### For Repository Maintainers

- [ ] Enable security advisories on GitHub
- [ ] Configure Dependabot alerts
- [ ] Regular security reviews of content
- [ ] Monitor for security-related issues
- [ ] Keep documentation updated

## 🔍 Security Monitoring

### Automated Monitoring

- **Dependency scanning**: Automated checks for known vulnerabilities
- **Content analysis**: Automated scanning for security issues
- **Access logs**: Monitoring of repository access patterns
- **Issue tracking**: Security-related issues are prioritized

### Manual Review

- **Regular security reviews**: Quarterly security assessments
- **Code reviews**: Security-focused review of all changes
- **Content audits**: Periodic review of all published content
- **Community feedback**: Monitor community reports of issues

## 🚨 Incident Response

### Severity Levels

| Level | Description | Response Time |
|-------|-------------|----------------|
| **Critical** | Immediate danger to users | Within 4 hours |
| **High** | Significant security impact | Within 24 hours |
| **Medium** | Moderate security issue | Within 3 days |
| **Low** | Minor security issue | Within 7 days |

### Response Process

1. **Assessment**: Evaluate the severity and impact
2. **Communication**: Notify affected users if needed
3. **Mitigation**: Implement temporary fixes if needed
4. **Resolution**: Develop and test permanent fixes
5. **Disclosure**: Coordinate public disclosure if needed

## 📞 Security Contacts

### Security Team
- **Email**: {{internalContact}}
- **Slack**: #security-team (if available)
- **GitHub**: @security-lead

### Reporting Security Issues
- **Primary**: {{internalContact}}
- **Backup**: Contact any Trusted Committer privately
- **Emergency**: {{internalContact}}

## 🔄 Security Updates

### How We Communicate
- **Security advisories**: Published on GitHub
- **Release notes**: Security fixes noted in releases
- **Email notifications**: For critical issues
- **Slack announcements**: For internal teams

### Update Process
- **Assessment**: Evaluate impact and urgency
- **Development**: Create and test fixes
- **Release**: Publish security updates
- **Notification**: Inform users of required actions

## 📚 Security Resources

### Recommended Reading
- [OWASP Prompt Injection Prevention](https://owasp.org/)
- [GitHub Security Best Practices](https://docs.github.com/en/code-security)
- [npm Security Best Practices](https://docs.npmjs.com/getting-started/securing-your-code)

### Security Tools
- **npm audit**: Check for known vulnerabilities
- **GitHub Dependabot**: Automated dependency updates
- **CodeQL**: Code analysis for security issues
- **Snyk**: Security scanning for dependencies

---

## 🤝 Contributing to Security

We welcome security contributions:
- **Report vulnerabilities** responsibly
- **Suggest improvements** to our security practices
- **Submit security-focused** pull requests
- **Participate in** security discussions

Thank you for helping keep {{projectName}} secure! 🛡️
