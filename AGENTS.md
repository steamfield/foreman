# forman

Instructions for coding agents working in this repository. Keep this file under about 200 lines: it is loaded at the start of every session. Put detail that matters only for one area in a doc and link it from Deeper context.

## Overview

forman lets Claude Code delegate coding tasks to OpenAI's Codex and supervise them while they run: start a Codex agent in a git worktree, watch what it does, steer or interrupt it, and answer questions Codex asks mid-turn. It drives `codex app-server` over JSON-RPC and uses the Codex CLI's own ChatGPT login, never an API key. It is a TypeScript CLI on Effect 4, compiled to one binary with Bun; an MCP server wrapping the CLI comes later. The command is `forman`; npm publication as `@steamfield/forman` is pending.

The CLI and bridge are implemented: the daemon supervises Codex turns, questions, budgets and repo hooks. See [README repo setup](README.md#one-time-repo-setup) before delegating into another repo.

## Commands

Run these from the repo root. They are the only supported way to build, test, and run the project; if a command here is wrong, fix it here in the same change.

| Command | What it does |
| --- | --- |
| `bun install` | Install dependencies; `prepare` then installs the lefthook git hooks (outside CI) |
| `bun run dev <args>` | Run the CLI from source; logs to `logs/cli.jsonl` and `logs/cli.log`, data under `.dev/data` |
| `bun run test` | The Vitest unit suite on Node (`src/**/*.test.ts`, `tests/`) |
| `bun run test:unit tests/cli.test.ts` | One test file (any path or name filter works) |
| `bun run coverage` | The unit suite with V8 coverage into `coverage/` |
| `bun run e2e` | Build, then run `e2e/` against the compiled binary with Bun's runner |
| `bun run smoke` | Development only: real Codex suite; build first, then set `FORMAN_SMOKE=1` (uses your login and plan) |
| `bun run lint` | Biome checks, including the `biome-plugins/` Grit rules |
| `bun run format` | Biome formatting and safe fixes |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run build` | Compile `dist/forman` for this host |
| `bun run check` | lint, typecheck, test and e2e: the gate before a commit |
| `bun run clean` | Remove `dist/`, `coverage/`, `logs/`, `.dev/` |
| `stacks verify` | The scaffold's definition of done (every check above plus doc and hook checks) |

## Architecture map

```
src/
  bin.ts         entry: supplies Bun platform services, Host and the process writers
  main.ts        the invocation boundary: runs the CLI, maps errors to exit codes, renders output once
  cli.ts         the Effect CLI command tree
  commands/      thin command handlers that call core/
  codex/         app-server JSON-RPC client, protocol and environment checks
  core/          platform-free command programs and doctor
    preflight/   worktree validation, hook trust, model selection and SSH probe
    runs/        persistence, normalization, worktree changes and digests
  daemon/        socket client/server, automatic startup and ownership lock
  supervisor/    app-server lifetime, turns, questions, budgets and wait cursors
  schemas/       Schema definitions for every boundary shape (args, config, machine output)
  services/      Context.Service classes: Host, Invocation, Output
  config.ts      file + environment config (only place that reads env)
  logging.ts     structured JSON logging, redaction, file sink
  errors.ts      tagged errors and the exit-code table
  runtime.ts     composes AppLayer
tests/           Vitest on Node: CLI through the real parser, config/logging, hook tests
e2e/             Bun tests against the compiled binary
scripts/         build, dev and prepare scripts
docs/            guidance per area, acceptance matrix, harness notes
biome-plugins/   Grit lint rules for the platform and schema boundaries
```

argv flows `bin.ts` → `main.ts` → `cli.ts` → `commands/*` → `core/*`; results go through the Output service to stdout, diagnostics through the logger to stderr and the log file.

## Agent harness

Claude Code hooks live in `.claude/hooks/` and are wired in `.claude/settings.json`; [`.claude/README.md`](.claude/README.md) lists each one and [`docs/harness.md`](docs/harness.md) explains the layers. Codex runs the same shell guards through `.codex/hooks.json` (`block-destructive.sh` for Bash, `.codex/hooks/check-patch.sh` for `apply_patch`), refusing the call if a guard is missing. Skills live in `.claude/skills/`; `.agents/skills` is a symlink to it, so Codex sees the same tree. Agents `architect` and `reviewer` are in `.claude/agents/`; commands `/check`, `/test`, `/feature` in `.claude/commands/`.

Codex does not load `.claude/rules/` automatically: it reads the rules covering the files it changes before editing them.

| Rule | Covers |
| --- | --- |
| `.claude/rules/effect.md` | `**/*.ts`, `**/*.tsx` |
| `.claude/rules/src/cli.md` | `src/bin.ts`, `src/main.ts`, `src/cli.ts`, `src/commands/**`, `src/services/output.ts`, `src/errors.ts` |
| `.claude/rules/src/effect-services.md` | `src/services/**`, `src/core/**`, `src/runtime.ts`, `src/config.ts`, `src/errors.ts`, `src/logging.ts` |
| `.claude/rules/src/typescript.md` | `**/*.ts` under `src/`, `tests/`, `scripts/`, `e2e/`, `.claude/hooks/` |
| `.claude/rules/src/testing.md` | `tests/**`, `e2e/**`, `vitest.config.ts`, `bunfig.toml` |
| `.claude/rules/src/verification.md` | `src/**`, `tests/**`, `e2e/**`, `scripts/**` |

## Conventions

- Commands follow `src/commands/doctor.ts`: a thin handler calling a program in `core/`, schemas in `schemas/`, results through Output. Register new commands in `cli.ts`.
- Services are namespaced `Context.Service` classes with static layers. Only `bin.ts` supplies Bun services; tests supply Node services. Core code stays platform-free (enforced by `guard-boundaries.ts` and `biome-plugins/boundaries.grit`).
- Only `config.ts` reads the environment. Project variables use the `FORMAN_` prefix. A new setting gets schema validation, a precedence test, and entries in `.env.example` and README.
- stdout carries results only; `--json` prints one JSON value. Failures leave stdout empty and render once on stderr.
- Schema comes from `effect`; never add `@effect/schema` or zod.
- Prefer the project's existing patterns and dependencies over new ones. Add a dependency only when nothing in the project already covers the need.
- Keep changes scoped to the task. Mention unrelated problems you notice instead of fixing them in the same change.

## Effect

Look up names in [`docs/guidance/effect/api.md`](docs/guidance/effect/api.md), verified against the installed `effect` and rewritten on every Effect upgrade. `tests/effect-testkit.test.ts` is the pattern for Effect tests. Upgrade `effect` and all `@effect/*` packages together, with Vitest inside `@effect/vitest`'s peer range.

## Schemas

Boundary schemas live in `src/schemas/`, one dependency-free file per domain importing only `effect`. Decode incoming data and encode outgoing data through them; use branded ids and tagged errors, and derive JSON Schema from them rather than writing it by hand. `tests/schema-conventions.test.ts` is the pattern. Detail: [`docs/guidance/effect-schema/index.md`](docs/guidance/effect-schema/index.md).

## Guardrails

- Destructive commands, credential-shaped writes and real `.env` writes are guarded by native hooks when this project targets Claude Code, Codex, OpenCode or Cursor. A block means ask the user; never rephrase a command or use another tool to bypass it.
- Store credentials in environment variables or a secrets manager. Write variable names and placeholders in `.env.example`; ask the user to set real values.
- Load the selected agent's applicable project skills or rules before changing their area.
- Treat lint diagnostics as work to resolve. Run the project check command before finishing; instructions and hooks do not replace tests.

## Testing

Unit tests (`src/*.test.ts`) cover pure contracts. `tests/cli.test.ts` drives the real parser and invocation boundary with temporary files and real Node services through `tests/helpers/cli.ts`. `tests/config-logging.test.ts` implements the matrix in `docs/acceptance/typescript-cli.md`. `e2e/binary.test.ts` runs the compiled binary with a clean environment. Vitest always runs on Node; Bun's runner only runs `./e2e`. `tests/helpers/setup.ts` isolates tests from a local `.env`. No mocks of project services; nothing needs to be running first.

- Behavior-focused tests against real dependencies where practical. Fake only what crosses the network to third parties.
- Automated tests never run real inference. Codex is the one third party: tests use the fake app server in `tests/fixtures/fake-app-server/`. `bun run smoke` hits real Codex and is a development tool only; never add it to `check`, git hooks or CI.
- A bug fix starts with a test that reproduces the bug.
- Weakening or skipping a test to get green is a failure, not a fix.

## Error handling

Errors are `Schema.TaggedError` classes in `src/errors.ts`, each with a row in the exhaustive `errorTable` (exit code, safe message, retryable). `main.ts` is the only place errors become exit codes and stderr output: 2 usage, 3 invalid config, 6 permission denied, 130 interrupted, 1 internal error (defects stay generic). A new error gets a class and a table row.

- Never swallow an error. Handle it, or add context and pass it on.
- Log an error once, at the boundary that handles it.

## Debugging

- If a fix hasn't worked after two attempts with no new diagnostic step in between, stop. Write down what you learned, list two or three other root-cause hypotheses, and ask which to pursue. Running a new diagnostic between attempts resets the count.
- Read logs and error output before guessing.

`bun run dev` appends JSON records to `logs/cli.jsonl` and copies stderr to `logs/cli.log` (rotated past 5 MB). Set `LOG_LEVEL=debug` for more; `FORMAN_LOG_FORMAT=json` switches stderr to JSON. Each run emits one `command` record (command, exit code, error tag, duration): debug on success, error on failure, filtered by the configured level.

## Git hooks

lefthook runs Biome on staged files at pre-commit (fixes are re-staged), `bun run typecheck` and `bun run test` in parallel at pre-push, and a Conventional Commits check (`type(scope): subject`) on commit messages. `bun install` installs the hooks through `scripts/prepare.ts`; install lefthook itself with `brew install lefthook`. Never `--no-verify`: fix the cause or the hook.

## CI

`.github/workflows/ci.yml` runs one `ci-ok` job on pushes to `main`, pull requests and manual dispatch: frozen install, lint, typecheck, coverage, then e2e, uploading logs and coverage on failure. Actions are pinned by commit SHA with the tag in a comment; Dependabot (`.github/dependabot.yml`) proposes weekly grouped updates for actions and bun dependencies, or resolve a new SHA with `git ls-remote --tags`.

## Build workarounds

None yet.

## Deferred

The MCP server wrapper, npm publishing and a release workflow.

## Pending user actions

- Create the GitHub repository and push. Confirm with `git remote -v`.
- Require the `ci-ok` check in the branch ruleset once the repository exists.
Repo trust and hook approval are done for this repo. For other repos, follow [README repo setup](README.md#one-time-repo-setup).

## Deeper context

Read these only when the task needs them.

| Need | Read |
| --- | --- |
| Usage, configuration, architecture | [`README.md`](README.md) |
| The hook layers and why | [`docs/harness.md`](docs/harness.md) |
| CLI, services, testing and verification guidance | [`docs/guidance/typescript-cli/index.md`](docs/guidance/typescript-cli/index.md) |
| Effect names and patterns | [`docs/guidance/effect/index.md`](docs/guidance/effect/index.md) |
| Config and logging acceptance matrix | [`docs/acceptance/typescript-cli.md`](docs/acceptance/typescript-cli.md) |
