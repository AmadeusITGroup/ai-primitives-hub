# Code Review Checklist

Use this checklist to ensure consistent and thorough code reviews.

## General

- [ ] Code compiles/builds without errors
- [ ] All tests pass
- [ ] No new warnings introduced
- [ ] PR description clearly explains the changes
- [ ] Linked issues are referenced

## Code Quality

### Readability
- [ ] Code is self-documenting with clear variable/function names
- [ ] Complex logic has explanatory comments
- [ ] Functions are focused and do one thing well
- [ ] No unnecessary complexity or over-engineering

### Maintainability
- [ ] Code follows project coding standards
- [ ] No code duplication (DRY principle)
- [ ] Proper separation of concerns
- [ ] Dependencies are appropriate and minimal

### Correctness
- [ ] Logic is correct and handles edge cases
- [ ] Error handling is appropriate
- [ ] Null/undefined checks where needed
- [ ] Boundary conditions are handled

## Testing

- [ ] New code has appropriate test coverage
- [ ] Tests are meaningful (not just for coverage)
- [ ] Edge cases are tested
- [ ] Tests are independent and repeatable
- [ ] Test names clearly describe what they test

## Security

- [ ] No hardcoded credentials or secrets
- [ ] Input validation is present
- [ ] SQL queries are parameterized (no injection risks)
- [ ] Sensitive data is not logged
- [ ] Authentication/authorization is properly implemented
- [ ] No exposure of sensitive information in errors

## Performance

- [ ] No obvious performance issues (N+1 queries, etc.)
- [ ] Appropriate use of caching
- [ ] No unnecessary database calls
- [ ] Large data sets are paginated
- [ ] Async operations are used appropriately

## Documentation

- [ ] Public APIs are documented
- [ ] README is updated if needed
- [ ] Breaking changes are documented
- [ ] Configuration changes are documented

## Architecture

- [ ] Changes align with project architecture
- [ ] No circular dependencies introduced
- [ ] Proper use of design patterns
- [ ] Backward compatibility maintained (or breaking changes documented)

---

## Quick Reference: Severity Levels

| Level | Description | Action |
|-------|-------------|--------|
| 🔴 **Blocker** | Security issue, data loss risk, or critical bug | Must fix before merge |
| 🟠 **Major** | Significant issue affecting functionality | Should fix before merge |
| 🟡 **Minor** | Code quality issue, minor bug | Fix recommended |
| 🟢 **Suggestion** | Style preference, optimization | Optional improvement |
| 💬 **Question** | Seeking clarification | Response needed |
