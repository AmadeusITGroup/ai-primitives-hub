# Feedback Guidelines

Guidelines for providing constructive, actionable feedback during code reviews.

## Core Principles

### 1. Be Specific and Actionable
❌ **Bad**: "This code is confusing."
✅ **Good**: "Consider renaming `processData()` to `validateUserInput()` to better reflect its purpose."

### 2. Explain the "Why"
❌ **Bad**: "Use a constant here."
✅ **Good**: "Extract `86400` to a named constant like `SECONDS_PER_DAY` for better readability and maintainability."

### 3. Distinguish Severity
Use prefixes to indicate the importance of your feedback:
- `[REQUIRED]` - Must be addressed before merge
- `[SUGGESTION]` - Recommended but not blocking
- `[QUESTION]` - Seeking clarification
- `[PRAISE]` - Acknowledging good work
- `[NIT]` - Minor style preference

### 4. Be Respectful
- Critique the code, not the person
- Use "we" instead of "you" when possible
- Acknowledge constraints and context
- Assume good intentions

## Feedback Templates

### Security Issue
```
[REQUIRED] Security: This endpoint accepts user input without validation.
Consider adding input sanitization to prevent injection attacks.
See: [OWASP Input Validation](https://owasp.org/www-community/Input_Validation_Cheat_Sheet)
```

### Performance Concern
```
[SUGGESTION] Performance: This loop queries the database on each iteration,
which could cause N+1 query issues with large datasets. Consider fetching
all required data upfront or using batch queries.
```

### Code Quality
```
[SUGGESTION] Readability: This function is 80 lines long and handles multiple
responsibilities. Consider extracting the validation logic into a separate
`validateOrder()` function for better testability and maintainability.
```

### Seeking Clarification
```
[QUESTION] I'm not sure I understand the business logic here. Could you
explain why we need to check both `isActive` and `isVerified`? Is there
a scenario where one could be true without the other?
```

### Acknowledging Good Work
```
[PRAISE] Great job handling the edge case where the user list is empty!
This defensive coding will prevent potential null pointer exceptions.
```

### Minor Style Suggestion
```
[NIT] Consider using destructuring here for cleaner code:
`const { name, email } = user;` instead of accessing properties individually.
```

## Anti-Patterns to Avoid

### Don't Be Vague
❌ "This doesn't look right."
❌ "Can you fix this?"
❌ "I don't like this approach."

### Don't Be Condescending
❌ "Obviously, you should..."
❌ "As everyone knows..."
❌ "This is a basic mistake."

### Don't Pile On
If multiple issues exist, prioritize the most important ones. Don't overwhelm with dozens of comments on a single PR.

### Don't Forget Context
Consider:
- Is this a hotfix under time pressure?
- Is this a proof of concept?
- Are there constraints you're not aware of?

## Receiving Feedback

### As the Author
- Assume good intentions from reviewers
- Ask for clarification if feedback is unclear
- Don't take feedback personally
- Thank reviewers for their time
- Explain your reasoning if you disagree

### Resolving Disagreements
1. Discuss the tradeoffs openly
2. Consider the team's coding standards
3. Escalate to tech lead if needed
4. Document decisions for future reference

---

## Quick Reference

| Prefix | Meaning | Blocking? |
|--------|---------|-----------|
| `[REQUIRED]` | Must fix | Yes |
| `[SUGGESTION]` | Should consider | No |
| `[QUESTION]` | Need clarification | Maybe |
| `[PRAISE]` | Good job! | No |
| `[NIT]` | Minor preference | No |
