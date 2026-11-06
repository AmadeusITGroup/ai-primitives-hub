# Primitives review action

Use this composite action to review AI primitives (prompts, instructions, agents, skills) under a path against a quality rubric. The rubric is built from the AI Primitives Hub author guides and the security rule catalogue. Each primitive gets a score, a grade, verified risk indications, and suggestions. The review runs with Gemma 4 on the runner, so no API key is needed.

```yaml
permissions:
  contents: read

steps:
  - uses: actions/checkout@v4
  - uses: AmadeusITGroup/ai-primitives-hub/github-actions/primitives-review@<commit-sha>
    with:
      path: skills/ prompts/
      # cli-version: '<version with security scan>'  # add static scanner findings and caps
      # fail-below: C                                 # turn the review into a gate
```

Pin the action to a full commit SHA. The report is written to the job summary and uploaded as the `primitives-review` artifact. `rubric.json` holds the criteria; pass your own with `rubric-file`. A ready-to-copy workflow is in [`examples/`](examples/).

See [Reviewing Primitives with Gemma 4](../../docs/author-guide/primitives-review.md) for the rubric, inputs, and how scores are grounded.
