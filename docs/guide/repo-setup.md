# Repo setup

Approve Codex project hooks, add agy hooks under .agents/, and check that foreman doctor accepts runs in the repository you delegate into.

Do this once per repository, from its main checkout. foreman never approves hooks or changes trust for you: when doctor or start refuses because of hooks, fix it in the provider or ask the repo owner.

## Codex: trust the project and approve hooks

Open Codex in the main checkout:

```sh
codex
```

Trust the project if prompted. If the repo has `.codex/hooks.json`, run `/hooks` inside Codex, read the project hooks and approve them. Exit Codex, then check:

```sh
foreman doctor
```

Each project hook should show `trusted` or `managed`, followed by `foreman start will accept runs here (hook trust).` Without `.codex/hooks.json` doctor prints `Repo hooks: no repo hooks apply.` and start doesn't check hooks.

`foreman start` repeats this check and refuses with exit 10 when any project hook is untrusted, fails to load or is missing. During a Codex turn foreman also checks that a project hook ran before the first shell command, and interrupts the turn with `repo hooks did not run` if none did.

Linked worktrees inside the main checkout inherit its approved hooks. When hook definitions change, reapprove them in the main checkout. A hook edit made in a delegated branch takes effect only after it reaches the main checkout.

## agy: commit an .agents/hooks.json

agy has no trust step. It runs `hooks.json` from `.agents/` (or `.agent/`, `_agents/`, `_agent/`) in the worktree it works in, so the committed copy is the one that matters.

foreman refuses an agy start with exit 10 when:

- the worktree's agy hooks file doesn't match agy's hook schema, or
- the repo has `.codex/hooks.json` but the worktree has no agy hooks file, because agy would then run without the repo's guards.

To guard agy with the same scripts as Codex, add an `.agents/hooks.json` whose `PreToolUse` hooks match agy's tool names: `run_command`, `write_file` and `edit_file`. foreman's own repo does this with [`.agents/hooks.json`](https://github.com/steamfield/foreman/blob/main/.agents/hooks.json) and an adapter script, [`guard-adapter.sh`](https://github.com/steamfield/foreman/blob/main/.agents/hooks/guard-adapter.sh), that turns agy's hook input into the payload the existing guards expect and denies the call when a guard is missing or fails.

ACP reports no hook runs, so foreman can't confirm a hook ran during an agy turn the way it does for Codex. A command a hook denied shows up as an ordinary failed tool call.

## Instructions the delegate loads itself

Both providers read repo instruction files on their own, so a contract doesn't need to repeat them.

| | Codex | agy |
| --- | --- | --- |
| Instruction files | `AGENTS.md` from the repo root down to the worktree | `GEMINI.md` and `AGENTS.md`, walking from the worktree to the repo root |
| Rules | No path-scoped rules | `.agents/rules/` |
| Skills | Installed skills, read when a task matches the description | `.agents/skills/` |

Preferences that should apply to every Codex delegate, in any repo, belong in your own `~/.codex/AGENTS.md`.

Claude Code's path-scoped rules in `.claude/rules/` reach neither provider by default. Two ways to close that gap:

- For Codex, copy [`.codex/hooks/inject-rules.ts`](https://github.com/steamfield/foreman/blob/main/.codex/hooks/inject-rules.ts) and its `apply_patch` and `PostCompact` entries in [`.codex/hooks.json`](https://github.com/steamfield/foreman/blob/main/.codex/hooks.json). It needs Bun, and sends the matching rules with Codex's first edit to a covered file.
- For agy, keep a copy of the rules in `.agents/rules/`, or name them in the contract's "Read first" section. A symlink from `.agents/skills` to `.claude/skills` shares skills the same way.

## Before the first start

Start validates more than hooks. A prepared worktree passed with `--worktree` must be its own git root, inside and distinct from the main checkout, and in a repo with `package.json` it needs `node_modules/` or `.pnp.cjs` unless you pass `--skip-deps-check`. With `--new-worktree`, pass `--setup "bun install"` (or your repo's install command) so dependencies exist before the delegate starts. See [Delegating a task](delegating.md#start-a-run).
