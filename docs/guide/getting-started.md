# Getting started

Install foreman, sign in to Codex or agy, install the Claude Code skill and run your first delegated task from a clean repository.

You need git, a repository with at least one commit, and [Node 26 or newer](https://nodejs.org/en/download) for the npm launcher. You need at least one provider: Codex, agy, or both.

## Install foreman

```sh
npm i -g @steamfield/foreman
```

The package pulls in a native binary for macOS or Linux on arm64 or x64, so keep optional dependencies enabled. `bun add -g @steamfield/foreman` works too, and `npx @steamfield/foreman` runs it without installing. Check it with `foreman --version`.

## Sign in to a provider

### Codex

Install Codex 0.171.0, the version foreman's protocol check is recorded against, and sign in with ChatGPT:

```sh
npm i -g @openai/codex@0.171.0
codex login
```

A different Codex version still works, but new runs carry a protocol warning. If a version-manager shim gets in the way, set `CODEX_BIN` to the real executable.

### agy

agy is optional. Install the Antigravity CLI (foreman's protocol check is recorded against agy 1.5.14), then run it once and sign in with your Google account:

```sh
agy
```

Set `AGY_BIN` when `agy` isn't on `PATH`. foreman uses agy's keyring sign-in, so Gemini API key variables are removed from the delegate's environment.

## Install the Claude Code skill

```sh
foreman skill install
```

This writes `$HOME/.claude/skills/foreman/SKILL.md`, the entry point that tells Claude to run `foreman guide` before its first command in a session. An identical file is left alone. If you edited your copy, inspect it, then replace it with `foreman skill install --force`. Other agents can read the same text from `foreman skill install --print`.

Rerun `foreman skill install` after each upgrade so the skill matches the binary.

## Check the setup

Run doctor from the main checkout of the repo you plan to delegate into:

```sh
foreman doctor
foreman models
```

Doctor checks config, each provider, hook trust, home permissions and the daemon without starting a turn or a daemon. It exits 0 even when a probe fails, so read every line. Look for:

- `Logged in: true` for Codex.
- An agy section with the version, sign-in, protocol and catalog size, or `agy: not installed`, which is fine if you only use Codex.
- `foreman start will accept runs here (hook trust).`, or `Repo hooks: no repo hooks apply.` in a repo without `.codex/hooks.json`.

If doctor says start will refuse runs, follow [Repo setup](repo-setup.md) first. `foreman models` lists every model each provider offers; see [Providers and models](providers.md).

## Your first delegation

Open Claude Code in the repo and ask:

> Use the foreman skill to delegate this task to Codex, then review its work.

Name a Gemini model (for example "delegate this to gemini-4-neon") to use agy instead. Claude reads `foreman guide`, fills a contract, starts the run with `--wait` in the background and handles questions as they come.

To try it by hand, write a small contract and start a read-only run:

```sh
contract=$(mktemp /tmp/foreman-contract.XXXXXX)
cat > "$contract" <<'CONTRACT'
Summarize how errors become exit codes in this repo.
- May change: `docs/notes.md`
Report what you found and any open questions.
CONTRACT
foreman start first-run --new-worktree --contract "$contract" --wait
```

Without `--model` the run goes to Codex's default model; add `--model gemini-4-neon` to send it to agy. Without `--write` the run is read-only. The command returns when the run needs attention. Then:

```sh
foreman result first-run     # the hand-off
foreman archive first-run    # free the name and remove the clean worktree
```

To watch while it works, open `foreman monitor` in another terminal ([Watching runs](monitor.md)). [Delegating a task](delegating.md) covers the full loop.
