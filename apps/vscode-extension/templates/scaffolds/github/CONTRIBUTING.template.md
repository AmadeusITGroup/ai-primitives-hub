# Contributing to {{projectName}}

We welcome contributions from all teams! This document explains how to contribute to this prompt collection.

## 🤝 How to Contribute

### For Internal Teams

1. **Fork this repository** (or create a feature branch if using a single-repo approach)
2. **Create a feature branch**: `git checkout -b feature/your-feature-name`
3. **Make your changes** following our development guidelines
4. **Test thoroughly**: Run all validation commands
5. **Submit a pull request** to the `main` branch

### Getting Manager Approval

Cross-team contributors should:
1. **Discuss the contribution** with your manager
2. **Estimate time commitment** (typically 2-8 hours for small changes)
3. **Get approval** before starting work
4. **Track time** for internal metrics

## 🛠️ Development Setup

### Prerequisites
- Node.js 18+ 
- Git

### Quick Start
```bash
# Clone your fork
git clone https://github.com/{{githubOrg}}/{{projectName}}.git
cd {{projectName}}

# Install dependencies
npm install

# Run validation
npm run validate
npm run skill:validate
```

## 👥 Trusted Committers

The following people have commit access and can review/merge pull requests:

<!-- TODO: Update with actual team members -->
- **[Team Lead]** (@github-handle) - [Team Name] - Available Mon-Fri, 9AM-5PM CET
- **[Tech Lead]** (@github-handle) - [Team Name] - Available Mon-Fri, 10AM-4PM CET

## 📋 Code Review Process

### Pull Request Requirements
- **Clear description** of what changes and why
- **Testing evidence** showing validation passes
- **Documentation updates** if applicable
- **Breaking changes** clearly marked if any

### Review Process
1. **Automated checks** must pass (CI/CD validation)
2. **At least one Trusted Committer** must approve
3. **Review SLA**: 2 business days for standard PRs
4. **Urgent PRs**: Tag @trusted-committers for expedited review

### 30-Day Warranty
Contributors are expected to:
- **Monitor for issues** for 30 days after merge
- **Fix bugs** introduced by their changes
- **Respond to questions** about their implementation

## 🧪 Testing Requirements

### Mandatory Validation
```bash
# Validate all collections
npm run validate

# Validate all skills  
npm run skill:validate

# Both must pass with 0 errors
```

### Manual Testing Checklist
- [ ] Content works as expected in Copilot Chat
- [ ] No broken file references
- [ ] YAML syntax is valid
- [ ] Examples are clear and functional
- [ ] Documentation is updated

## 📝 Content Guidelines

### Quality Standards
- **Clear purpose**: Each prompt/instruction should have a specific goal
- **Consistent formatting**: Follow existing patterns and naming conventions
- **Tested examples**: Include working examples where applicable
- **Documentation**: Update relevant documentation for new features

### Content Types
- **Prompts** (`.prompt.md`): Single-task instructions
- **Instructions** (`.instructions.md`): Team standards and best practices  
- **Agents** (`.agent.md`): AI personas with specific expertise
- **Skills** (`SKILL.md`): Complex capabilities with bundled assets
- **Collections** (`.collection.yml`): Organized groups of related content

## 🚀 Getting Help

### Questions During Development
- **Tag @trusted-committers** in your PR for questions
- **Use GitHub Discussions** for general questions
- **Slack Channel**: `#{{projectName}}-dev` (if available)

### Escalation Path
1. **Trusted Committers** → Technical questions
2. **Team Lead** → Process or priority questions  
3. **InnerSource Office** → Cross-team coordination issues

## 📊 Recognition

### Contribution Metrics
- **GitHub contributions** are automatically tracked
- **Quarterly recognition** for active contributors
- **Skill badges** for different contribution types

### Types of Contributions We Value
- 🎯 **New prompts/instructions** for specific use cases
- 📚 **Documentation improvements** and examples
- 🐛 **Bug fixes** and validation improvements
- 🛠️ **Tooling and automation** enhancements
- 💡 **Feature suggestions** and feedback

## ⚖️ Code of Conduct

Please be respectful and professional in all interactions. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for detailed guidelines.

---

## 🎉 Ready to Contribute?

1. **Fork** this repository
2. **Create** your feature branch
3. **Make** your changes
4. **Test** thoroughly
5. **Submit** your pull request

We look forward to your contributions! 🚀
