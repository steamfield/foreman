# Providers and models

How foreman picks Codex or agy from the model you name, which models each provider lists, their defaults, and where the two providers behave differently.

A provider is the agent a run delegates to: `codex` or `agy`. You never choose it directly. `foreman start --model <id>` looks the model up in each provider's catalog and routes the run there, and the run keeps that provider for every later turn. A follow-up can't switch providers; a different model means a new run.

## Listing models

```sh
foreman models
```

```text
PROVIDER  MODEL                  EFFORTS                          DEFAULT EFFORT
codex     gpt-6.2-sol (default)  low,medium,high,xhigh,max,ultra  high
codex     gpt-6.2-astra          low,medium,high,xhigh,max,ultra  high
agy       gemini-4-neon          low,medium,high,xhigh            high
agy       gemini-3.8-flash       low,medium,high                  high
agy       gpt-oss-120b-medium    fixed                            -
```

The output above is trimmed, and the versions change as providers release models. Codex lists the `gpt-*-sol`, `gpt-*-terra` and `gpt-*-astra` families (and others) at several versions. agy lists `gemini-4-neon`, `gemini-4-argon`, `gemini-4-hydrogen`, `gemini-3.8-flash` and models from other vendors that your account can use. A model marked `fixed` has one built-in effort. A provider that isn't available is listed with the reason, and `--json` returns the same catalogs as one value.

## Where the catalogs come from

| Provider | Catalog | Refreshed |
| --- | --- | --- |
| `codex` | `CODEX_HOME/models_cache.json` (default `~/.codex/models_cache.json`), entries Codex marks visible | By Codex itself |
| `agy` | `agy models`, cached at `$FOREMAN_HOME/providers/agy/models.json` | When the cache is missing, older than a day or from another agy version, and once when a model is in neither catalog and the cache is over an hour old |

Because routing reads catalogs instead of matching name patterns, a model either provider adds works without a foreman release. Listing agy's models creates no conversation.

## How a model is resolved

Resolution happens in the CLI before the daemon or a worktree is touched, so a wrong model costs nothing.

1. `codex:<model>` or `agy:<model>` checks only that provider's catalog.
2. An exact id that one catalog lists picks that provider.
3. An agy id with an effort suffix (`-low`, `-medium`, `-high`, `-xhigh`) means the family plus that effort, so `--model gemini-4-neon-high` is the same run as `--model gemini-4-neon --effort high`.
4. A model both catalogs list is ambiguous; add the prefix.

An unknown, ambiguous or hidden model fails with exit 2 and a near-miss suggestion naming the provider when there is one. With `--json` the error envelope includes a `candidates` list.

## Defaults

| Setting | Codex | agy |
| --- | --- | --- |
| Model when `--model` is omitted | `defaultModel` from config, else the newest visible `gpt-*-sol` in Codex's cache (built-in fallback `gpt-6.1-sol`) | Never chosen automatically; name an agy model, or set one as `defaultModel` |
| Effort | `high` | `high` when the model offers it, else its highest effort; none for a fixed-effort model |
| Service tier | `priority` | Not applicable |
| Question timeout | 15 minutes | 100 seconds (capped below agy's 180-second hold) |

`defaultModel` goes through the same routing as `--model`, so it can name a model from either provider.

## Effort and tier

`--effort` sets reasoning effort for the run. Codex checks the value itself. agy accepts only the efforts `foreman models` lists for that family, and an effort that conflicts with a suffixed id (`--model gemini-4-neon-high --effort low`) fails. `followup --effort` changes the effort for that turn and every later one, checked the same way.

`--tier` sets the Codex service tier and applies only to Codex. Passing it with an agy model fails with exit 2.

## Where the providers differ

Every command other than `start` works the same on both providers: `wait`, `answer`, `defer`, `steer`, `followup`, `interrupt`, `result`, `archive` and `monitor`. The differences are in how each provider enforces access and holds questions.

| Behavior | Codex | agy |
| --- | --- | --- |
| Read-only runs | OS sandbox, network disabled | agy's edit tools are refused, shell commands are allowed. The run carries a warning and fails if a shell command changed files |
| Write runs (`--write`) | Full host access, approval policy `never` | foreman allows every permission request |
| A refused permission | The sandbox denies the call and the turn continues | agy ends the turn, so foreman records the run as failed, naming the refused tool |
| Questions | A dynamic `ask_orchestrator` tool | The same tool through an MCP server foreman starts per session; agy drops a held call after about 180 seconds |
| Steering | Codex can refuse a steer (exit 8); wait for the turn, then follow up | The steer joins the running turn as a second prompt; one that arrives after agy finished the turn is refused the same way |
| Repo hooks | Trusted in Codex; foreman checks a hook ran before the first command | Run from the worktree's `.agents/hooks.json`; foreman can't see hook runs |
| Interrupt | An unconfirmed interrupt leaves the run `unknown` until recovery settles it | foreman waits up to 30 seconds for agy to confirm, then abandons the prompt and marks the run interrupted |
| Contract template | `foreman guide contract` (self-review with `codex exec`) | `foreman guide contract agy` (self-review with `agy -p`) |

Use Codex for read-only work that must not write: only Codex enforces it with a sandbox. [Repo setup](repo-setup.md) covers the hook differences, and [How it works](how-it-works.md#provider-sessions) covers the sessions behind them.
