# Overview

foreman lets Claude Code hand coding tasks to Codex or agy in git worktrees, answer their questions, and review the diff before anything is committed.

Claude Code is the orchestrator. Codex (OpenAI) or agy (Google's Antigravity CLI, serving Gemini and a few other vendors' models) is the delegate. You ask Claude to delegate a task, and Claude writes a contract, starts a run, answers the delegate's questions, sends corrections and reviews the result through foreman commands. You can watch all of it live in `foreman monitor`.

A local daemon owns every run, so a turn keeps going after the command that started it exits. foreman drives `codex app-server` with your Codex ChatGPT login and `agy acp` (the Agent Client Protocol) with your agy sign-in. Neither needs an API key: foreman removes OpenAI and Gemini key variables from the delegate's environment, so a run can't bill a key by accident.

## What a delegation looks like

```sh
foreman guide contract > /tmp/fix-hooks.md        # fill in the template
foreman start fix-hooks --new-worktree --contract /tmp/fix-hooks.md --write --wait
foreman answer fix-hooks q1 "Keep the public API" --wait
foreman result fix-hooks                           # read the hand-off, then review the diff
foreman archive fix-hooks
```

Claude runs these for you once the skill is installed. The model passed to `start --model` picks the provider; every other command works the same on both.

## Terms

| Term | Meaning |
| --- | --- |
| Run | One delegated task with a short unique name, such as `fix-hooks`. It has its own git worktree and branch, so it never touches your checkout. |
| Contract | The written task: the goal, the files the run may change and the files it must not. Scope is a review aid, not a sandbox. |
| Turn | One round of work in a run. Turn 1 is the start; later turns come from follow-ups, late answers or a budget hand-off. |
| Provider | The agent that runs a task: `codex` or `agy`. The model a run starts with picks it, and the run keeps it. |
| Question | The delegate pausing to ask. It waits for an answer, and after the question timeout is deferred so the delegate carries on with independent work. A late answer is still accepted. |
| Budget | A time limit per working turn, 60 minutes by default. At expiry foreman interrupts and asks for a read-only hand-off. |
| Hand-off | The report the delegate writes when a turn ends. |
| Daemon | The local process that owns run state and the provider sessions. Run commands start it on demand. |

## Run states

| State | Meaning |
| --- | --- |
| `starting` | foreman is opening a session or starting a turn |
| `running` | A turn is active |
| `waiting` | The delegate asked a question and is holding for an answer |
| `unknown` | foreman can't confirm whether the delegate is still executing; the worktree stays reserved |
| `idle` | The last turn finished normally |
| `failed` | The turn or a supervisor operation failed |
| `interrupted` | The turn was interrupted, including by a budget expiry |
| `lost` | Supervision ended, for example because the daemon or provider process died |

The first four are active: the run owns its worktree and refuses `followup` and `archive`. The last four are inactive, and you can continue, inspect or archive them.

## Where to go next

| You want to | Read |
| --- | --- |
| Install foreman and run a first task | [Getting started](getting-started.md) |
| Prepare another repo for delegation | [Repo setup](repo-setup.md) |
| Choose between Codex and agy, or pick a model | [Providers and models](providers.md) |
| Understand the full delegation loop | [Delegating a task](delegating.md) |
| Watch runs in a terminal | [Watching runs](monitor.md) |
| Know what the daemon does and how recovery works | [How it works](how-it-works.md) |
| Look up a command, flag or exit code | [Command reference](cli.md) |
| Change paths, defaults or logging | [Configuration](configuration.md) |

An MCP server wrapper, Channels push notifications and launchd installation are not built yet.
