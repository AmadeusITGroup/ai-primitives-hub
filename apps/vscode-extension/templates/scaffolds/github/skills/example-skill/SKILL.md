---
name: example-skill
description: 'Performs thorough code reviews following best practices. Use when reviewing pull requests, checking code quality, or ensuring coding standards compliance.'
license: SEE LICENSE IN LICENSE
metadata:
  author: '{{author}}'
  version: '1.0.0'
compatibility: 'Requires git. Works with GitHub Copilot, Claude, and other Agent Skills-compatible tools.'
---

# Code Review Skill

This skill helps you perform thorough, consistent code reviews following industry best practices and your team's coding standards.

## When to Use This Skill

Use this skill when you need to:
- Review pull requests or merge requests
- Check code quality and identify potential issues
- Ensure compliance with coding standards
- Provide constructive feedback to developers
- Identify security vulnerabilities or performance issues

## Review Process

### 1. Initial Assessment
Before diving into details, understand the context:
- Read the PR description and linked issues
- Understand the purpose and scope of changes
- Check if tests are included

### 2. Code Quality Checks
Review the code using the [checklist](./references/CHECKLIST.md):
- **Correctness**: Does the code do what it's supposed to do?
- **Readability**: Is the code easy to understand?
- **Maintainability**: Will this be easy to modify in the future?
- **Performance**: Are there any obvious performance issues?
- **Security**: Are there any security vulnerabilities?

### 3. Run Automated Checks
Use the provided scripts to automate common checks:

```bash
# Run the review helper script
./scripts/review-helper.sh <path-to-file>
```

### 4. Provide Feedback
Follow the [feedback guidelines](./references/FEEDBACK.md) for constructive comments:
- Be specific and actionable
- Explain the "why" behind suggestions
- Distinguish between required changes and suggestions
- Acknowledge good practices

## Common Patterns to Watch For

### Security Issues
- Hardcoded credentials or secrets
- SQL injection vulnerabilities
- Cross-site scripting (XSS) risks
- Insecure deserialization
- Missing input validation

### Performance Issues
- N+1 query problems
- Unnecessary loops or iterations
- Missing caching opportunities
- Large memory allocations
- Blocking operations in async code

### Code Smells
- Functions that are too long (>50 lines)
- Too many parameters (>4)
- Deep nesting (>3 levels)
- Duplicated code
- Magic numbers or strings

## Templates

Use the [comment templates](./assets/comment-templates.md) for consistent feedback:
- `[REQUIRED]` - Must be fixed before merge
- `[SUGGESTION]` - Nice to have, not blocking
- `[QUESTION]` - Seeking clarification
- `[PRAISE]` - Acknowledging good work

## Example Review Comments

### Good Example
```
[SUGGESTION] Consider extracting this logic into a separate function 
for better testability. The current implementation mixes data fetching 
with business logic, making it harder to unit test.
```

### Bad Example
```
This is wrong.
```

## Best Practices

1. **Review in small batches** - Don't try to review 1000+ lines at once
2. **Take breaks** - Fresh eyes catch more issues
3. **Use checklists** - Ensure consistency across reviews
4. **Be timely** - Don't block teammates for too long
5. **Learn continuously** - Each review is a learning opportunity

## Resources

- [Code Review Checklist](./references/CHECKLIST.md)
- [Feedback Guidelines](./references/FEEDBACK.md)
- [Comment Templates](./assets/comment-templates.md)
- [Review Helper Script](./scripts/review-helper.sh)
