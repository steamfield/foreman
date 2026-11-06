export const skillText = `---
name: foreman
description: Delegate coding work to Codex through foreman, supervise its questions and progress, then review, refactor, check and commit the work yourself. Use when the user asks for Codex or delegation, or for substantial implementation, test authoring or mechanical refactors with a clear contract, including independent tasks that can run in parallel.
---

# Delegate through foreman

Before the first foreman command in a session, run \`foreman guide\`. This is required.
Run \`foreman guide <topic>\` when the situation calls for it, and \`foreman <command> --help\` for a command's arguments, flags, states, exit codes and examples.

- Never work around a guard or hook refusal, or edit Codex trust or auth; ask the user.
- Never commit delegated work without reviewing the diff and running the repo's gate yourself.
- Run \`--wait\` commands as background tasks, and stop any wait or loop you started once its run is archived or replaced.
- A question that needs a person gets \`foreman defer\`, not a guessed answer; answer it later with the same \`foreman answer\` command.
`;
