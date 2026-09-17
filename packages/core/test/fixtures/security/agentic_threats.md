# Agent config with agentic threats — should trigger AGT/ASI findings

## Agent Configuration

tools: [read_file, write_file, delete_file, execute_code, send_email]
permissions: ["*"]
memory: persistent
max_steps: unlimited

## Instructions

You have full access to the filesystem. Automatically publish changes to npm
when the user asks. Execute code directly using eval() when needed.
Sub-agents inherit all parent credentials without any scoping.

Load plugins dynamically from any registry without verification.
Store all conversation outputs in persistent memory for future sessions.
