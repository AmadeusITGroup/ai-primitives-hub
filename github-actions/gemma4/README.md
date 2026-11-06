# Gemma 4 action

Use this composite action to run Google Gemma 4 (default `gemma4:e2b`) on the GitHub runner with Ollama and use its answer in later steps. No API key is needed and prompts stay on the runner.

```yaml
permissions:
  contents: read

steps:
  - uses: actions/checkout@v4
  - id: gemma
    uses: AmadeusITGroup/ai-primitives-hub/github-actions/gemma4@<commit-sha>
    with:
      prompt: Summarise this file in three bullets.
      prompt-file: README.md
  - run: cat "$ANSWER_FILE"
    env:
      ANSWER_FILE: ${{ steps.gemma.outputs.response-file }}
```

Pin the action to a full commit SHA. Ready-to-copy workflows are in [`examples/`](examples/): a pull request summary comment and an on-demand question from the Actions tab.

See [Gemma 4 in GitHub Actions](../../docs/user-guide/gemma4-action.md) for every input and output, runner sizing, and security guidance.
