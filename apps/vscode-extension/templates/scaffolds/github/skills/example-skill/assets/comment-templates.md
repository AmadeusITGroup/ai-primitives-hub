# Code Review Comment Templates

Copy-paste templates for consistent code review feedback.

## Required Changes

### Security Issue
```
[REQUIRED] 🔴 Security: [Brief description of the issue]

**Problem**: [Explain what's wrong]
**Risk**: [Explain the potential impact]
**Fix**: [Suggest how to fix it]

Reference: [Link to relevant documentation]
```

### Critical Bug
```
[REQUIRED] 🔴 Bug: [Brief description]

This will cause [describe the failure scenario].

**Steps to reproduce**:
1. [Step 1]
2. [Step 2]

**Expected**: [What should happen]
**Actual**: [What happens instead]
```

### Breaking Change
```
[REQUIRED] 🔴 Breaking Change: This modifies the public API

Existing consumers of `functionName()` will break because [reason].

Please either:
- Maintain backward compatibility, or
- Document the breaking change in CHANGELOG.md
```

## Suggestions

### Refactoring
```
[SUGGESTION] 🟡 Refactor: Consider extracting this into a separate function

**Current**: [Describe current state]
**Proposed**: Extract to `functionName()` for:
- Better testability
- Improved readability
- Reusability

Example:
\`\`\`javascript
function functionName(params) {
  // extracted logic
}
\`\`\`
```

### Performance
```
[SUGGESTION] 🟡 Performance: [Brief description]

This could be optimized by [suggestion].

**Current complexity**: O(n²)
**Proposed complexity**: O(n)

This matters when [explain when it becomes a problem].
```

### Naming
```
[SUGGESTION] 🟢 Naming: Consider renaming `oldName` to `newName`

The current name suggests [what it implies], but the function actually [what it does].

A more descriptive name would help future readers understand the code faster.
```

### Error Handling
```
[SUGGESTION] 🟡 Error Handling: Consider adding error handling here

If `operation` fails, this will [describe failure mode].

Consider wrapping in try-catch:
\`\`\`javascript
try {
  // operation
} catch (error) {
  // handle gracefully
}
\`\`\`
```

## Questions

### Clarification
```
[QUESTION] 💬 Could you explain the reasoning behind [specific decision]?

I see that [observation], but I'm not sure why [specific question].

Is this because of [possible reason A] or [possible reason B]?
```

### Business Logic
```
[QUESTION] 💬 Business Logic: Is this the expected behavior?

When [condition], this code will [behavior].

Is this intentional? The ticket mentions [what ticket says], which seems different.
```

### Testing
```
[QUESTION] 💬 Testing: How should we test this scenario?

I notice there's no test for [specific case]. Should we add one, or is this covered elsewhere?
```

## Praise

### Good Practice
```
[PRAISE] ✨ Great job on [specific thing]!

This [explain why it's good]:
- [Benefit 1]
- [Benefit 2]
```

### Learning Opportunity
```
[PRAISE] ✨ Nice use of [pattern/technique]!

For others reading: this is a good example of [explain the pattern] which helps with [benefits].
```

## Nits (Minor)

### Style
```
[NIT] Consider [minor style suggestion].

Not blocking, just a preference for consistency with [reference].
```

### Documentation
```
[NIT] A brief comment here would help explain [what needs explaining].

Something like: `// [suggested comment]`
```

---

## Emoji Legend

| Emoji | Meaning |
|-------|---------|
| 🔴 | Blocker - must fix |
| 🟠 | Major - should fix |
| 🟡 | Minor - recommended |
| 🟢 | Suggestion - optional |
| 💬 | Question - needs response |
| ✨ | Praise - good job! |
