# CLI Commands

This directory contains the CLI's Clipanion command classes.

## Adding a command

1. Add the command module under this directory.
2. Define a `Command` subclass.
3. Declare its canonical command path in `static readonly paths`.
4. Register the class in `registry.ts`.
5. Add or update tests for observable behavior through the CLI entry point.

The registry is the production CLI's command list. A command that is not
registered there is not available to users, even if its module and tests exist.
The same registration is used by command dispatch, help output, and generated
shell completion, so no secondary command or completion list should be added.

Add aliases as additional entries in the command's `paths` array.

`defineCommand()` remains available through the framework for declarative
commands and test compatibility. Native commands in this directory should use
the command-class pattern.

## Removing a command

Remove the command module, its entry in `registry.ts`, any aliases, and its
command-specific tests or documentation together.

## Checklist

- [ ] The command declares every canonical path and alias.
- [ ] The command is registered in `registry.ts`.
- [ ] Tests cover its public CLI behavior.
- [ ] No duplicate command registry or completion list was introduced.
