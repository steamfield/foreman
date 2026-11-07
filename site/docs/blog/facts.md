# foreman blog fact sheet

2026-11-06; checked locally: foreman v0.1.0, codex-cli 0.166.0, git 2.56.0, Bun 1.4.2; Claude Code behavior below is documentation-sourced, not a local version test.

> Writer rule: treat `[built-in]` as documented default or command behavior, name the required command, flag or setting for `[configurable]`, and leave `[not verified]` claims out of articles.

## foreman

### Identity, installation and requirements

- foreman lets Claude Code delegate coding tasks to Codex in git worktrees while a local daemon supervises progress, questions and hand-offs. (`README.md:3`; `docs/architecture.md:3`) [built-in]
- foreman drives the local `codex app-server` through persistent threads rather than invoking `codex exec` for each task. (`docs/architecture.md:33`; `src/supervisor/turns.ts:306`) [built-in]
- The documented npm installation command is `npm i -g @steamfield/foreman`. (`README.md:12`) [configurable]
- The documented alternative installation and invocation commands are `bun add -g @steamfield/foreman` and `npx @steamfield/foreman`. (`README.md:19`) [configurable]
- The npm launcher requires Node 26 or newer, git and a repository with at least one commit. (`README.md:9`) [built-in]
- Packaged native binaries target macOS and Linux on arm64 and x64 and require npm optional dependencies to remain enabled. (`README.md:19`) [built-in]
- The supported Codex protocol is pinned to version `0.166.0`, which matched this machine's `codex --version` output. (`src/codex/protocol.ts:10`; local `codex --version` capture below) [built-in]
- The documented Codex setup is `npm i -g @openai/codex@0.166.0`, then `codex login`, then `foreman doctor`. (`README.md:14`) [configurable]
- Building foreman from source requires Bun 1.4 or newer and uses `bun install` followed by `bun run build`. (`README.md:173`) [configurable]
- foreman's repository URL is https://github.com/steamfield/foreman. (`package.json:8`) [built-in]
- foreman's npm URL is https://www.npmjs.com/package/@steamfield/foreman. (`site/src/config.ts:10`) [built-in]
- foreman is MIT licensed. (`README.md:210`) [built-in]

### Commands

- `foreman guide [<topic>]` prints the installed binary's workflow or contract template without contacting Codex or the daemon. (`src/commands/guide.ts:26`) [built-in]
- `foreman skill` groups the bundled agent-skill commands. (`src/commands/skill.ts:50`) [built-in]
- `foreman skill install` installs the matching entry point at `$HOME/.claude/skills/foreman/SKILL.md` and leaves an identical file unchanged. (`src/commands/skill.ts:34`) [configurable]
- `foreman skill install --force` replaces a different installed regular file, while `--print` prints the skill without writing it. (`src/commands/skill.ts:11`; `src/core/skill.ts:55`) [configurable]
- `foreman start <name>` starts a new run using exactly one of `--new-worktree` and `--worktree`. (`src/commands/runs.ts:140`) [configurable]
- `foreman status [<name>]` prints a full digest for one named run or lists the current repository group's runs and orphan worktrees. (`src/commands/runs.ts:175`) [built-in]
- `foreman events <name>` reads stored events without resuming the run. (`src/commands/runs.ts:213`) [built-in]
- `foreman events --after <n> --limit <n> --verbose` selects a numeric event page and can include protocol chatter and token usage hidden by default in text output. (`README.md:74`; `docs/architecture.md:133`) [configurable]
- `foreman answer <name> <question-id> <text>` answers a pending question, delivers a late answer or corrects a previous answer. (`src/commands/runs.ts:319`) [built-in]
- `foreman defer <name> <question-id> [<note>]` releases a pending question without deciding it. (`src/commands/runs.ts:358`) [built-in]
- `foreman steer <name> <message>` sends new instructions to a running, steerable turn. (`src/commands/runs.ts:233`) [built-in]
- `foreman followup <name> <message>` starts another turn on an inactive run's saved thread and existing worktree. (`src/commands/runs.ts:260`) [built-in]
- `foreman interrupt <name>` requests interruption of an active turn or cancels start preflight. (`src/commands/runs.ts:281`) [built-in]
- `foreman result <name>` prints the digest and latest available hand-off with its turn number. (`README.md:80`; `docs/architecture.md:107`) [built-in]
- `foreman archive <name>` archives an inactive run's records and cleans up its managed worktree when cleanup is safe. (`src/commands/runs.ts:404`) [built-in]
- `foreman archive <name> --keep-worktree` archives records while retaining the managed worktree and branch. (`src/commands/runs.ts:404`) [configurable]
- `foreman wait <name>...` waits for attention from named runs, while `foreman wait --all` selects the current repository group. (`src/commands/runs.ts:443`) [configurable]
- `foreman doctor` reports configuration, executable identity, Codex login and protocol, hook trust, home permissions, orphan worktrees and daemon build. (`src/commands/doctor.ts:70`; `src/core/doctor.ts:230`) [built-in]
- `foreman daemon` runs the supervisor in the foreground instead of relying on automatic daemon startup. (`README.md:84`) [configurable]
- `foreman daemon stop` stops an idle daemon, succeeds if none exists and refuses while active runs, preflight or queued answers need it. (`src/commands/daemon.ts:39`) [built-in]
- Every foreman command accepts `--json` and `--help`, and successful JSON output is one result value. (`README.md:65`; `docs/architecture.md:31`) [configurable]
- `answer`, `steer` and `followup` accept a message argument or `--file <path>`. (`README.md:65`) [configurable]
- The guide topics are `core` by default, `contract`, `contract tests`, `supervise`, `review` and `recover`. (`src/guide/topics.ts:122`; `src/core/guide.ts:15`) [built-in]

### Start flags and worktrees

- `start --new-worktree` creates `<main>/.claude/worktrees/<name>` on branch `foreman/<name>` at the caller's HEAD. (`src/core/managed-worktree.ts:117`; `docs/architecture.md:137`) [configurable]
- `start --from <ref>` chooses the new worktree's base ref and requires `--new-worktree`. (`README.md:86`; `src/commands/runs.ts:100`) [configurable]
- `start --worktree <path>` accepts a prepared linked worktree at its git root, inside and distinct from the main checkout. (`README.md:86`) [configurable]
- Prepared worktrees and their branches are never removed by foreman. (`src/core/managed-worktree.ts:236`; `docs/architecture.md:141`) [built-in]
- A prepared worktree containing `package.json` needs `node_modules/` or `.pnp.cjs` unless `--skip-deps-check` is supplied. (`README.md:86`) [configurable]
- `start --setup <command>` runs `/bin/sh -c` in the new worktree before validation and Codex, with a ten-minute default setup timeout. (`src/core/managed-worktree.ts:195`; `docs/architecture.md:139`) [configurable]
- An explicitly supplied `start --budget <duration>` replaces the setup timeout and separately sets the working turn's budget. (`docs/architecture.md:139`; `src/commands/runs.ts:125`) [configurable]
- `start --contract <file>` loads the per-task brief that follows foreman's shared delegate preamble on the first turn. (`src/commands/runs.ts:109`; `src/supervisor/turns.ts:322`) [configurable]
- `start --model <id>` overrides selection of the newest visible `gpt-*-sol` from `CODEX_HOME/models_cache.json`, with fallback `gpt-6.1-sol`. (`src/commands/runs.ts:117`; `README.md:149`) [configurable]
- `start --effort <value>` overrides the default reasoning effort `high`. (`src/supervisor/turns.ts:277`; `src/commands/runs.ts:121`) [configurable]
- `start --tier <value>` overrides the default service tier `priority`. (`src/supervisor/turns.ts:278`; `src/commands/runs.ts:122`) [configurable]
- `start --question-timeout <duration>` overrides the default fifteen-minute wait before deferring an unanswered question. (`src/supervisor/turns.ts:280`; `src/commands/runs.ts:129`) [configurable]
- `start --wait` waits for this run's attention after acceptance, with `--timeout <duration>` controlling the separate attention wait. (`src/commands/runs.ts:140`; `src/commands/runs.ts:38`) [configurable]
- Without `--wait`, start returns after starting the run and the daemon owns its continuing lifetime. (`README.md:3`; `src/commands/runs.ts:140`) [built-in]
- foreman defaults to a read-only sandbox whose turn policy sets `networkAccess: false`. (`src/supervisor/turns.ts:48`; `src/supervisor/turns.ts:279`) [built-in]
- `start --write` selects `danger-full-access` with app-server policy `dangerFullAccess`, allowing full host access and network without approval prompts. (`src/supervisor/turns.ts:48`; `src/supervisor/turns.ts:78`; `src/commands/runs.ts:114`) [configurable]
- foreman's run schema supports only `read-only` and `danger-full-access`, with no `workspace-write` run mode. (`src/schemas/daemon.ts:41`) [built-in]
- A foreman write run's git worktree separates Git edits but does not restrict its access to the host. (`docs/architecture.md:123`) [built-in]
- The delegate preamble instructs Codex to leave changes uncommitted, avoid pushing and work in its assigned worktree. (`src/supervisor/prompts.ts:2`) [built-in]
- The guide tells the orchestrator to inspect `git diff` and `git status`, review new files and scope drift, and run the repository gate before committing or merging. (`src/guide/topics.ts:20`) [built-in]
- Archive refuses active runs and runs with queued answers. (`src/commands/runs.ts:404`) [built-in]
- Managed archive cleanup refuses a missing worktree, detached HEAD, unexpected branch, dirty or untracked files, or new commits not merged into the recorded source ref. (`src/core/managed-worktree.ts:242`) [built-in]
- Managed archive uses Git's final dirty check and deletes the branch against an expected commit id to protect concurrent commits. (`src/core/managed-worktree.ts:262`) [built-in]
- Scope entries are backticked paths on the `- May change:` line and its continuation lines. (`src/core/runs/worktree.ts:58`) [built-in]
- Scope reporting supports directory prefixes, star globs and literal suffix matches and lists dirty paths outside the declared scope. (`src/core/runs/worktree.ts:69`; `src/core/runs/worktree.ts:116`) [built-in]
- The scope digest is a review aid rather than a write restriction, and follow-ups retain the original contract's scope. (`README.md:88`; `docs/architecture.md:143`) [built-in]
- The `filesWritten` scan uses modification times and prunes build and cache directories, so it is not an audit trail of every write. (`src/core/runs/worktree.ts:39`; `src/core/runs/worktree.ts:94`; `docs/architecture.md:143`) [built-in]

### Run states, questions and budgets

- `starting` means foreman is preparing a thread or starting a turn. (`docs/architecture.md:84`; `src/schemas/daemon.ts:23`) [built-in]
- `running` means a turn is active. (`docs/architecture.md:85`; `src/schemas/daemon.ts:23`) [built-in]
- `waiting` means a turn holds a pending question tool call. (`src/supervisor/questions.ts:139`; `docs/architecture.md:86`) [built-in]
- `unknown` means execution is unconfirmed and foreman retains worktree ownership while recovering. (`docs/architecture.md:87`; `src/supervisor/registry.ts:282`) [built-in]
- `idle` means the last turn completed normally. (`src/supervisor/notifications.ts:203`; `docs/architecture.md:88`) [built-in]
- `failed` means a turn or supervisor operation failed. (`src/supervisor/notifications.ts:204`; `docs/architecture.md:89`) [built-in]
- `interrupted` includes an interrupted turn and a completed budget hand-off. (`src/supervisor/notifications.ts:206`; `docs/architecture.md:90`) [built-in]
- `lost` means app-server or daemon supervision ended. (`src/supervisor/registry.ts:217`; `docs/architecture.md:91`) [built-in]
- The active states are `starting`, `running`, `waiting` and `unknown`. (`src/schemas/daemon.ts:34`) [built-in]
- Each new thread receives the dynamic `ask_orchestrator` tool for questions and blockers. (`src/supervisor/turns.ts:311`; `src/schemas/codex.ts:295`) [built-in]
- foreman assigns question ids `q1`, `q2` and onward across the run and holds the originating RPC connection until resolution. (`src/supervisor/questions.ts:125`; `src/supervisor/questions.ts:139`) [built-in]
- A pending `answer` responds to the held tool call, while `defer` or the default fifteen-minute timeout sends the deferral prompt. (`src/supervisor/questions.ts:64`; `src/supervisor/questions.ts:147`; `src/supervisor/index.ts:401`) [built-in]
- The first sentence of the deferral prompt is "No answer yet; the decision may need a person and can take a while." (`src/supervisor/prompts.ts:8`) [built-in]
- The deferral prompt says "Continue with all work that doesn't depend on it." (`src/supervisor/prompts.ts:8`) [built-in]
- The deferral prompt says "For the question itself, take no irreversible step and nothing outside the contract; if a safe, reversible default exists, use it and say so; otherwise leave that part undone." (`src/supervisor/prompts.ts:8`) [built-in]
- The deferral prompt says "End your turn normally and list the question, and what you did about it, under Open." (`src/supervisor/prompts.ts:8`) [built-in]
- The deferral prompt ends "The answer will arrive as a message later." (`src/supervisor/prompts.ts:8`) [built-in]
- Deferral is prompt guidance whose reasoning and choice foreman does not enforce. (`docs/architecture.md:113`) [built-in]
- Deferred questions remain visible as unanswered in digests until answered or superseded. (`docs/architecture.md:113`; `src/core/runs/digest.ts:182`) [built-in]
- A late `answer` to the same id steers a running turn or starts a follow-up after inactivity if steering is refused. (`src/commands/runs.ts:319`) [built-in]
- Answering an already answered id sends a correction containing the original question context. (`src/commands/runs.ts:319`) [built-in]
- Answers queue in acceptance order during a budget hand-off or behind earlier queued answers. (`src/commands/runs.ts:319`; `docs/architecture.md:101`) [built-in]
- An ordinary `steer` or `followup` supersedes unanswered decisions, while their ids remain addressable. (`docs/architecture.md:115`) [built-in]
- Working turns default to a sixty-minute budget that `--budget` can override for start or follow-up. (`src/supervisor/turns.ts:324`; `src/supervisor/turns.ts:461`) [configurable]
- Budget expiry interrupts the working turn and cancels pending questions before requesting a separate read-only hand-off turn. (`src/supervisor/turns.ts:90`; `src/supervisor/notifications.ts:199`; `src/supervisor/turns.ts:126`) [built-in]
- The hand-off turn has a separate ten-minute budget and instructs Codex to stop working and run no more commands. (`src/supervisor/turns.ts:184`; `src/supervisor/prompts.ts:5`) [built-in]
- A finished budget hand-off leaves the run interrupted and a later follow-up restores the run's configured sandbox. (`src/supervisor/notifications.ts:206`; `src/supervisor/turns.ts:126`) [built-in]
- A hand-off that exceeds its own budget is interrupted without creating another hand-off. (`docs/architecture.md:105`; `src/supervisor/turns.ts:151`) [built-in]
- A run can end without a hand-off, and `result` searches backward for the latest available one with its turn number. (`docs/architecture.md:107`) [built-in]

### Waits, daemon lifetime and trust

- `wait --all` supervises the group identified by the main checkout's real path, while run names are global within `FOREMAN_HOME`. (`docs/architecture.md:62`) [configurable]
- Wait outcome `events` reports attention kinds `question`, `done`, `failed`, `interrupted` or `lost` with refreshed digests. (`README.md:109`; `src/supervisor/wait.ts:122`) [built-in]
- Wait outcome `timeout` means no new attention arrived before the deadline. (`README.md:110`) [built-in]
- Wait outcome `none` means `--all` has no active runs or unseen attention in the group. (`README.md:111`) [built-in]
- All successful wait outcomes exit zero and carry a continuation cursor. (`README.md:113`; `src/commands/runs.ts:443`) [built-in]
- `wait --after <cursor>` uses an opaque cursor carrying run identities and event positions rather than the numeric sequences accepted by `events --after`. (`docs/architecture.md:129`; `docs/architecture.md:133`) [configurable]
- Group cursors preserve repository identity across directories and run identities prevent name reuse from hiding a new run. (`README.md:113`) [built-in]
- Printed `next:` lines suggest the next command and preserve the cursor and explicit wait timeout for ordinary continuations. (`docs/architecture.md:131`) [built-in]
- Mutation `--wait` continuations target the named run, and explicit `wait --all` remains available to supervise peers. (`src/commands/runs.ts:140`; `docs/architecture.md:129`) [configurable]
- foreman starts one app-server child lazily per daemon and routes separate runs by persistent thread id. (`src/supervisor/app-server.ts:76`; `src/supervisor/app-server.ts:119`; `docs/architecture.md:33`) [built-in]
- The daemon exits after thirty minutes with no busy runs and no open client connections. (`src/daemon/server.ts:194`; `docs/architecture.md:43`) [built-in]
- Active runs, worktree preflight reservations and queued answers count as busy, and an open wait connection also keeps the daemon alive. (`docs/architecture.md:43`) [built-in]
- A run command replaces an idle outdated daemon with the caller's build, while a busy outdated daemon continues serving compatible requests until a later replacement attempt. (`docs/architecture.md:45`; `docs/architecture.md:50`) [built-in]
- An outdated busy daemon refuses managed starts and deferrals and accepts answers only for questions it still reports pending. (`docs/architecture.md:54`) [built-in]
- Replacement compares build identity rather than version ordering, so a polling older executable can replace an idle newer daemon. (`docs/architecture.md:58`) [built-in]
- App-server death marks its active runs lost and cancels pending questions, and the next request needing Codex starts a new child. (`src/supervisor/app-server.ts:83`; `src/supervisor/registry.ts:217`; `docs/architecture.md:33`) [built-in]
- A daemon restart marks previously active runs lost rather than silently continuing their turns. (`docs/architecture.md:93`; `src/supervisor/registry.ts:217`) [built-in]
- An inactive run needs both a saved thread id and an existing worktree to resume. (`docs/architecture.md:33`; `src/commands/runs.ts:260`) [built-in]
- Resuming does not recreate the dynamic question tool, so resumed-thread question delivery depends on Codex retaining it. (`docs/architecture.md:33`; `src/schemas/codex.ts:93`) [built-in]
- An unconfirmed request retains ownership in `unknown` recovery and can retire the shared app-server after a five-minute deadline, affecting peer runs. (`docs/architecture.md:93`) [built-in]
- Accepted answer delivery queues live in daemon memory and are not reconstructed after a daemon crash. (`docs/architecture.md:95`) [built-in]
- When the main checkout contains `.codex/hooks.json`, start requires Codex to report project hooks for the target worktree as trusted or managed without loading errors. (`src/core/preflight/hooks.ts:8`; `src/core/preflight/hooks.ts:43`) [built-in]
- Missing project hooks also fail that trust check, and foreman never approves hooks itself. (`src/core/preflight/hooks.ts:48`; `README.md:51`) [built-in]
- The documented trust setup is to open Codex in the main checkout, trust the project if asked, approve hooks through `/hooks`, then inspect `foreman doctor`. (`README.md:37`; `src/core/preflight/hooks.ts:29`) [configurable]
- The README says linked worktrees inside the main checkout inherit its approved hooks and delegated-branch hook edits take effect after reaching the main checkout. (`README.md:51`) [built-in]
- Mid-turn enforcement interrupts when a command-execution item starts before any required project-hook-start notification for that turn. (`src/supervisor/notifications.ts:104`; `src/supervisor/notifications.ts:219`) [built-in]
- This mid-turn check confirms that a project hook ran in the turn rather than that every command ran every hook. (`docs/architecture.md:121`; `src/supervisor/notifications.ts:219`) [built-in]
- The app-server child environment strips `OPENAI_API_KEY`, `OPENAI_API_BASE`, `CODEX_API_KEY`, `CLAUDE_*`, `FOREMAN_*` and `LOG_LEVEL` and adds `CODEX_DELEGATE=1` and `STACKS_DELEGATE=1`. (`src/codex/environment.ts:7`) [built-in]
- API-key environment stripping does not prove ChatGPT-only authentication because doctor checks only `codex login status` success and Codex can reuse cached API-key credentials. (`src/core/doctor.ts:205`; `src/codex/environment.ts:7`; <https://learn.chatgpt.com/docs/auth#credential-storage>) [built-in]
- Doctor reports unavailable probes in its result and can exit zero even when setup needs attention. (`src/commands/doctor.ts:70`; `src/core/doctor.ts:195`) [built-in]
- Doctor never starts a Codex turn or starts or replaces the foreman daemon and never approves hooks or changes authentication. (`src/commands/doctor.ts:70`) [built-in]
- Protocol compatibility compares generated schema hashes and warns on mismatch rather than refusing start solely for a different version or hash. (`src/codex/protocol.ts:5`; `src/supervisor/app-server.ts:61`; `docs/architecture.md:35`) [built-in]
- Foreman's app-server connection gives `thread/start` 180 seconds for MCP startup and other RPCs thirty seconds by default while leaving global Codex MCP servers enabled. (`docs/architecture.md:35`; `src/supervisor/turns.ts:314`) [built-in]
- The MCP server wrapper, Channels push, launchd installation and archive-deletion command remain deferred. (`AGENTS.md:144`; `README.md:5`; `docs/architecture.md:145`) [built-in]

### Exit codes

- Exit `0` covers success, all successful wait outcomes and doctor reports with unavailable probes. (`README.md:121`; `src/commands/doctor.ts:70`) [built-in]
- Exit `1` means an internal error. (`src/errors.ts:67`) [built-in]
- Exit `2` covers invalid commands, arguments and input files. (`src/errors.ts:54`; `src/errors.ts:95`) [built-in]
- Exit `3` means invalid configuration. (`src/errors.ts:55`) [built-in]
- Exit `4` means the daemon request could not be completed. (`src/errors.ts:68`) [built-in]
- Exit `5` means Codex is unavailable. (`src/errors.ts:73`) [built-in]
- Exit `6` means permission denied, including file and socket permission failures. (`src/errors.ts:60`; `README.md:127`) [built-in]
- Exit `7` means the run or question was not found. (`src/errors.ts:78`) [built-in]
- Exit `8` covers run conflicts and unreadable or unsupported run data. (`src/errors.ts:79`; `README.md:129`) [built-in]
- Exit `9` means an invalid worktree or missing dependencies. (`src/errors.ts:84`; `README.md:130`) [built-in]
- Exit `10` means repository-hook trust was not confirmed. (`src/errors.ts:89`) [built-in]
- Exit `130` means the CLI invocation was interrupted. (`src/errors.ts:66`) [built-in]
- Command failures leave stdout empty and render on stderr, with the last stderr line carrying an error envelope under `--json`. (`README.md:134`) [configurable]

### Recorded story and documentation disagreements

- The product spec reports four release-fix delegates named `fix-cli`, `fix-daemon`, `fix-supervisor` and `fix-worktrees` running in parallel from one commit for 24 to 70 minutes each. (`site/docs/PRODUCT.md:13`) [built-in]
- The same recorded story reports one scope question answered in nineteen seconds and another question deferred after the fifteen-minute timeout. (`site/docs/PRODUCT.md:13`) [built-in]
- The product spec explicitly has no measurement supporting general speed or cost savings claims. (`site/docs/PRODUCT.md:75`) [built-in]
- The product spec's assertion that scope globs match literally disagrees with current code, which uses `Glob.match` for entries containing `*`. (`site/docs/PRODUCT.md:104`; `src/core/runs/worktree.ts:71`) [built-in]
- The product spec's "ChatGPT login only" and landing copy's "no OpenAI API key involved" are stronger than the code's environment filter and login-status probe establish. (`site/docs/PRODUCT.md:50`; `site/src/data/landing.ts:6`; `src/codex/environment.ts:7`; `src/core/doctor.ts:205`) [built-in]

## Codex CLI

### Exec, worktrees and approval settings

- Installed `codex exec` is the non-interactive command, aliased as `codex e`. (local `codex --help`: "Run Codex non-interactively") [built-in]
- `codex exec` accepts its task as a prompt argument or stdin and appends piped stdin as a `<stdin>` block when a prompt argument is also supplied. (local `codex exec --help`) [configurable]
- Non-interactive mode streams progress to stderr and prints the final agent message to stdout by default. (<https://learn.chatgpt.com/docs/non-interactive-mode#basic-usage>) [built-in]
- `codex exec --json` prints events to stdout as JSONL. (local `codex exec --help`: "Print events to stdout as JSONL") [configurable]
- `codex exec -o <file>` or `--output-last-message <file>` writes the final message to the named file. (local `codex exec --help`) [configurable]
- `codex exec --output-schema <file>` supplies a JSON Schema for the final response shape. (local `codex exec --help`) [configurable]
- `codex exec --worktree` starts a session in a new managed Git worktree. (local `codex exec --help`: "Run the session in a new managed Git worktree") [configurable]
- `codex exec -C <dir>` or `--cd <dir>` selects the agent's working root. (local `codex exec --help`) [configurable]
- `codex exec resume <session-id> [<prompt>]` resumes a recorded session and `--last` selects the newest. (local `codex exec resume --help`) [configurable]
- Although resume help exposes `--worktree`, the pinned CLI source rejects `codex exec resume --worktree` and directs callers to `codex exec fork --worktree`. (<https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/cli/src/main.rs#L2308>; local `codex exec resume --help`) [built-in]
- The pinned exec implementation exits `1` when the primary turn fails or is interrupted or receives a non-retrying error, so exit zero alone does not establish that requested tests passed. (<https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/exec/src/lib.rs#L1344>; <https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/exec/src/lib.rs#L1411>) [built-in]
- Non-interactive mode defaults to read-only and `--sandbox workspace-write` allows workspace edits. (<https://learn.chatgpt.com/docs/non-interactive-mode#basic-usage>) [configurable]
- The installed sandbox flag accepts exactly `read-only`, `workspace-write` and `danger-full-access`. (local `codex exec --help`) [configurable]
- Sandbox mode controls filesystem and command-network access, while approval policy controls when an action needs approval. (<https://learn.chatgpt.com/docs/agent-approvals-security#sandbox-and-approvals>) [built-in]
- The installed interactive `--ask-for-approval` flag accepts `on-request` and `never`. (local `codex --help`) [configurable]
- `on-request` lets the model decide when to ask for approval, while `never` returns execution failures to the model without asking. (local `codex --help`) [configurable]
- `codex exec --help` has no separate `--ask-for-approval` option and the pinned exec implementation normally defaults headless approval policy to `never`. (local `codex exec --help`; <https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/exec/src/lib.rs#L594>) [built-in]
- `--approve-for-me` routes approval requests through automatic review with the `workspace-write` sandbox. (local `codex exec --help`) [configurable]
- `--dangerously-bypass-approvals-and-sandbox` skips confirmation prompts and command sandboxing. (local `codex exec --help`) [configurable]
- The official security guide says `approval_policy = "untrusted"` is retired and can prevent startup, while the installed interactive help lists only `on-request` and `never`. (<https://learn.chatgpt.com/docs/agent-approvals-security#migrate-from-the-retired-untrusted-approval-policy>; local `codex --help`) [built-in]
- `workspace-write` command networking defaults off and `[sandbox_workspace_write] network_access = true` enables it. (<https://learn.chatgpt.com/docs/agent-approvals-security#network-access>) [configurable]
- App-server `tool/requestUserInput` can request answers to one to three short questions. (<https://learn.chatgpt.com/docs/app-server#api-overview>) [built-in]
- App-server command approvals arrive as `item/commandExecution/requestApproval` server requests that require a client decision. (<https://learn.chatgpt.com/docs/app-server#approvals>) [built-in]
- A `commandExecution` item reports command status, output and optional exit code and duration, providing separate evidence from a pending question or approval request. (<https://learn.chatgpt.com/docs/app-server#items>) [built-in]
- foreman's fifteen-minute question deferral applies to its held `ask_orchestrator` calls rather than diagnosing every slow command or approval request. (`src/supervisor/questions.ts:109`; `src/supervisor/questions.ts:147`) [built-in]

### App-server, parallel sessions and existing-session commands

- `codex app-server` is the JSON-RPC integration interface for clients that manage threads, turns and streamed notifications. (<https://learn.chatgpt.com/docs/app-server>) [built-in]
- The installed app-server supports `--listen stdio://` by default, `unix://`, `unix://PATH`, `ws://IP:PORT` and `off`, with `--stdio` as a stdio alias. (local `codex app-server --help`) [configurable]
- `codex app-server generate-ts` generates TypeScript protocol bindings and `generate-json-schema` generates JSON Schema for that installed version. (local `codex app-server --help`; <https://learn.chatgpt.com/docs/app-server#message-schema>) [built-in]
- `codex app-server daemon` manages the shared local app-server daemon with subcommands including `start`, `restart`, `stop`, `version`, `bootstrap`, `update` and remote-control enablement. (local `codex app-server daemon --help`) [configurable]
- `codex --no-daemon` runs the interactive CLI without the shared background server even when one is already running. (local `codex --help`) [configurable]
- `codex agents` browses all agent sessions on the shared local app-server daemon. (local `codex agents --help`) [built-in]
- `codex queue --thread <id-or-name> --message <text>` queues a message for an existing session. (local `codex queue --help`) [configurable]
- `codex queue --resume` attempts to resume the thread after queueing and still succeeds with a warning if resumption fails. (local `codex queue --help`) [configurable]
- `codex resume` opens a previous interactive session using a picker by default or `--last` for the newest. (local `codex resume --help`) [built-in]
- `codex fork` forks a previous interactive session using a picker by default or `--last` for the newest. (local `codex fork --help`) [built-in]
- `codex resume --include-non-interactive` includes non-interactive sessions in the picker and `--last` selection. (local `codex resume --help`) [configurable]
- The installed top-level help lists `mcp` for managing external MCP servers and does not list `mcp-server`. (local `codex --help`) [built-in]
- Running `codex mcp-server --help` here exited zero and printed output identical to `codex --help`, which does not demonstrate a working MCP-server subcommand. (local `codex mcp-server --help` and `codex --help`, compared byte-for-byte) [built-in]

### Login, instructions and hooks

- Codex CLI supports ChatGPT sign-in for subscription access and API-key sign-in for usage-based access. (<https://learn.chatgpt.com/docs/auth#openai-authentication>) [built-in]
- ChatGPT sign-in uses the account's Codex entitlement and limits, while API-key usage is billed to the OpenAI Platform account at standard API rates rather than included ChatGPT plan credits. (<https://learn.chatgpt.com/docs/auth#sign-in-with-an-api-key>; <https://learn.chatgpt.com/docs/pricing>) [built-in]
- Official pricing lists Free, Go, Plus, Pro, Business, Edu and Enterprise plans with plan-specific feature and model limits. (<https://learn.chatgpt.com/docs/pricing>) [built-in]
- `codex login --with-api-key` reads a key from stdin, `--with-access-token` reads an access token and `--device-auth` selects device authentication. (local `codex login --help`) [configurable]
- Codex reuses locally cached login credentials from `~/.codex/auth.json` or an OS credential store. (<https://learn.chatgpt.com/docs/auth#credential-storage>) [built-in]
- Codex discovers instructions once per run, beginning with the first nonempty `AGENTS.override.md` or `AGENTS.md` in `CODEX_HOME`, which defaults to `~/.codex`. (<https://learn.chatgpt.com/docs/agent-configuration/agents-md#how-codex-discovers-guidance>) [built-in]
- Project instruction discovery walks from the project root to the current directory and selects at most one of `AGENTS.override.md`, `AGENTS.md` or configured fallback names in each directory. (<https://learn.chatgpt.com/docs/agent-configuration/agents-md#how-codex-discovers-guidance>) [built-in]
- Codex concatenates discovered instruction files root first so instructions nearer the working directory override earlier guidance. (<https://learn.chatgpt.com/docs/agent-configuration/agents-md#how-codex-discovers-guidance>) [built-in]
- The combined project instruction limit defaults to 32 KiB and can be changed with `project_doc_max_bytes`, while `project_doc_fallback_filenames` configures alternative names. (<https://learn.chatgpt.com/docs/agent-configuration/agents-md#how-codex-discovers-guidance>) [configurable]
- A task-specific `codex exec` prompt supplies initial task instructions alongside the separately discovered AGENTS.md guidance. (local `codex exec --help`; <https://learn.chatgpt.com/docs/agent-configuration/agents-md>) [configurable]
- Codex discovers hooks from `~/.codex/hooks.json`, `<repo>/.codex/hooks.json`, inline `[hooks]` config and enabled plugin hook sources. (<https://learn.chatgpt.com/docs/hooks#where-codex-looks-for-hooks>) [configurable]
- Project-local hooks load only when the project's `.codex/` configuration layer is trusted. (<https://learn.chatgpt.com/docs/hooks#where-codex-looks-for-hooks>) [built-in]
- In the pinned release, linked-worktree hook discovery redirects the matching `.codex` hook folder to the root checkout. (<https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/config/src/loader/mod.rs#L1146>) [built-in]
- The pinned linked-worktree loader preserves ordinary worktree-local project config while replacing inline hook declarations with the matching root-checkout layer. (<https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/config/src/loader/mod.rs#L1967>) [built-in]
- Non-managed hooks require review and trust against the current definition's hash, and changed definitions are skipped until reviewed again. (<https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks>) [built-in]
- `/hooks` lets users inspect sources, review and trust new or changed hooks, or disable individual non-managed hooks. (<https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks>) [configurable]
- Managed hooks are trusted by policy and cannot be disabled from the user hook browser. (<https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks>) [built-in]
- `--dangerously-bypass-hook-trust` runs enabled hooks without persisted hook trust for that invocation and is documented for automation that already vets hook sources. (local `codex --help`; <https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks>) [configurable]

## OpenAI Codex plugin for Claude Code

- The plugin is confirmed official because the public `openai/codex-plugin-cc` repository is owned by GitHub's `openai` organization. (<https://github.com/openai/codex-plugin-cc>; <https://api.github.com/repos/openai/codex-plugin-cc>) [built-in]
- Its README describes using Codex inside Claude Code for code reviews and delegated tasks through the local Codex app server and global `codex` binary. (<https://github.com/openai/codex-plugin-cc/blob/main/README.md#codex-integration>) [built-in]
- The README requires Node.js 18.18 or later and a ChatGPT subscription including Free or an OpenAI API key, with usage contributing to Codex usage limits. (<https://github.com/openai/codex-plugin-cc/blob/main/README.md#requirements>) [built-in]
- Installation starts with `/plugin marketplace add openai/codex-plugin-cc` inside Claude Code. (<https://github.com/openai/codex-plugin-cc/blob/main/README.md#install>) [configurable]
- Installation continues with `/plugin install codex@openai-codex`, `/reload-plugins` and `/codex:setup` in that order. (<https://github.com/openai/codex-plugin-cc/blob/main/README.md#install>) [configurable]
- The README's manual CLI setup uses `npm install -g @openai/codex` and `!codex login` if authentication is needed. (<https://github.com/openai/codex-plugin-cc/blob/main/README.md#install>) [configurable]
- `/codex:setup` checks installation and authentication and can offer npm installation when Codex is missing. (<https://github.com/openai/codex-plugin-cc/blob/main/README.md#codexsetup>) [built-in]
- `/codex:review` performs a read-only review of uncommitted changes or `--base <ref>` branch changes and supports `--wait` and `--background`. (<https://github.com/openai/codex-plugin-cc/blob/main/README.md#codexreview>) [configurable]
- The README says `/codex:review` is not steerable and accepts no custom focus text. (<https://github.com/openai/codex-plugin-cc/blob/main/README.md#codexreview>) [built-in]
- `/codex:adversarial-review` performs a read-only, steerable challenge review with optional focus text and the same target, wait and background flags. (<https://github.com/openai/codex-plugin-cc/blob/main/README.md#codexadversarial-review>) [configurable]
- `/codex:rescue` delegates through the `codex:codex-rescue` subagent and supports `--background`, `--wait`, `--resume`, `--fresh`, `--model` and `--effort`. (<https://github.com/openai/codex-plugin-cc/blob/main/README.md#codexrescue>) [configurable]
- Rescue can offer the latest rescue thread when neither `--resume` nor `--fresh` is supplied and otherwise lets Codex choose default model and effort when omitted. (<https://github.com/openai/codex-plugin-cc/blob/main/README.md#codexrescue>) [built-in]
- The plugin maps rescue model alias `spark` to `gpt-5.3-codex-spark`. (<https://github.com/openai/codex-plugin-cc/blob/main/README.md#codexrescue>) [configurable]
- `/codex:transfer` imports the current Claude Code session into a persistent Codex thread and prints `codex resume <session-id>`. (<https://github.com/openai/codex-plugin-cc/blob/main/README.md#codextransfer>) [built-in]
- Transfer obtains the transcript path from a `SessionStart` hook or `--source`, requires the source under `~/.claude/projects` and requires a Codex version exposing session import. (<https://github.com/openai/codex-plugin-cc/blob/main/README.md#codextransfer>) [configurable]
- `/codex:status [<job-id>]` shows running and recent jobs for the current repository. (<https://github.com/openai/codex-plugin-cc/blob/main/README.md#codexstatus>) [built-in]
- `/codex:result [<job-id>]` shows a finished job's stored final output and its Codex session id when available. (<https://github.com/openai/codex-plugin-cc/blob/main/README.md#codexresult>) [built-in]
- `/codex:cancel [<job-id>]` cancels an active background Codex job. (<https://github.com/openai/codex-plugin-cc/blob/main/README.md#codexcancel>) [built-in]
- `/codex:setup --enable-review-gate` enables a `Stop` hook that runs targeted Codex review and blocks stopping when issues are found, and `--disable-review-gate` disables it. (<https://github.com/openai/codex-plugin-cc/blob/main/README.md#enabling-review-gate>) [configurable]
- The README warns that the optional review gate can create a long-running Claude/Codex loop and consume usage limits quickly. (<https://github.com/openai/codex-plugin-cc/blob/main/README.md#enabling-review-gate>) [configurable]
- The plugin uses existing local Codex authentication and configuration, including trusted project `.codex/config.toml` overrides. (<https://github.com/openai/codex-plugin-cc/blob/main/README.md#common-configurations>) [built-in]

## Claude Code

- Claude Code subagents have their own context windows, system prompts, tool access and permissions and return results to the main conversation. (<https://code.claude.com/docs/en/sub-agents>) [built-in]
- Foreground subagents block the conversation while background subagents run concurrently as the user continues working. (<https://code.claude.com/docs/en/sub-agents#run-subagents-in-foreground-or-background>) [configurable]
- Setting subagent `isolation: worktree` runs it in its own repository worktree. (<https://code.claude.com/docs/en/sub-agents#frontmatter-reference>) [configurable]
- Claude Code can run Bash commands asynchronously and immediately return a background task id. (<https://code.claude.com/docs/en/interactive-mode#background-bash-commands>) [built-in]
- A user can request background execution or press `Ctrl+B` during a Bash invocation, with two presses needed under tmux. (<https://code.claude.com/docs/en/interactive-mode#how-backgrounding-works>) [configurable]
- Background Bash output is written to a file that Claude can read while remaining responsive to new prompts. (<https://code.claude.com/docs/en/interactive-mode#how-backgrounding-works>) [built-in]
- Claude Code normally cleans up background Bash tasks on exit, so that mechanism has a different lifetime from foreman's daemon-owned runs. (<https://code.claude.com/docs/en/interactive-mode#how-backgrounding-works>; `docs/architecture.md:3`) [built-in]
- Prefixing input with `!` runs a shell command directly and adds its output to Claude Code's conversation. (<https://code.claude.com/docs/en/interactive-mode#shell-mode-with--prefix>) [configurable]
- `claude --worktree <name>` starts a separate branch checkout and can be repeated with another name for a parallel session. (<https://code.claude.com/docs/en/common-workflows#run-parallel-sessions-with-worktrees>) [configurable]
- Personal skills live at `~/.claude/skills/<skill-name>/SKILL.md` and project skills at `.claude/skills/<skill-name>/SKILL.md`. (<https://code.claude.com/docs/en/skills#choose-where-skills-load>) [configurable]
- Claude Code plugins package skills, agents, hooks, MCP servers or other components as one installed unit. (<https://code.claude.com/docs/en/plugins>) [built-in]
- A marketplace is a catalog listing plugins and their fetch locations, and `/plugin` exposes marketplace plugins through Discover. (<https://code.claude.com/docs/en/plugins>) [configurable]
- `claude mcp add --transport http <name> <url>` adds a remote HTTP MCP server. (<https://code.claude.com/docs/en/mcp#option-1-add-a-remote-http-server>) [configurable]
- `claude mcp add --transport stdio <name> -- <command> [args...]` adds a local stdio server with the server command after `--`. (<https://code.claude.com/docs/en/mcp#option-3-add-a-local-stdio-server>) [configurable]
- `/diff` shows all uncommitted working-tree edits, including changes made by something other than Claude Code. (<https://code.claude.com/docs/en/interactive-mode#review-changes-with-diff>) [built-in]

## git worktrees

- Linked worktrees provide separate working files, HEAD and index. (<https://git-scm.com/docs/git-worktree#_details>) [built-in]
- Object storage is shared through the common Git directory. (<https://git-scm.com/docs/gitrepository-layout#_description>) [built-in]
- Branch and tag refs are shared, with exceptions including `refs/bisect`, `refs/worktree` and `refs/rewritten`. (<https://git-scm.com/docs/git-worktree#_refs>) [built-in]
- Repository configuration is shared by default. (<https://git-scm.com/docs/git-worktree#_configuration_file>) [built-in]
- `extensions.worktreeConfig` enables per-worktree configuration through `git config --worktree`. (<https://git-scm.com/docs/git-worktree#_configuration_file>) [configurable]
- Git's default hooks directory is shared through `$GIT_COMMON_DIR/hooks`. (<https://git-scm.com/docs/gitrepository-layout#_description>) [built-in]
- `git worktree add <path> <branch>` creates a checkout of a branch. (<https://git-scm.com/docs/git-worktree#_description>) [configurable]
- `git worktree list` lists the main and linked worktrees with checkout details. (<https://git-scm.com/docs/git-worktree#_commands>) [built-in]
- `git worktree remove <path>` normally refuses tracked modifications or untracked files. (<https://git-scm.com/docs/git-worktree#_commands>) [built-in]
- `git worktree prune` cleans administrative records for missing worktrees. (<https://git-scm.com/docs/git-worktree#_commands>) [built-in]
- `git worktree lock` prevents normal pruning, movement and removal. (<https://git-scm.com/docs/git-worktree#_commands>) [configurable]
- Removing an unclean worktree requires `--force`, while removing a locked worktree requires `--force` twice. (<https://git-scm.com/docs/git-worktree#_options>) [configurable]
- Git normally refuses to check out the same branch in another worktree. (<https://git-scm.com/docs/git-worktree#_options>) [built-in]
- A worktree's separate checkout and shared repository metadata do not establish Codex filesystem or network permissions, which are controlled separately by Codex sandbox configuration. (<https://git-scm.com/docs/git-worktree#_details>; <https://learn.chatgpt.com/docs/agent-approvals-security#sandbox-and-approvals>) [built-in]

## Captured output

### `foreman --help` (exit 0)

```text
DESCRIPTION
  Delegate coding tasks to Codex in git worktrees and supervise their questions, progress and hand-offs. Run guide before your first delegation. Exits 0 for help, 2 for usage, 6 when output is refused, 130 when interrupted, 1 on an internal error.

USAGE
  foreman <subcommand> [flags]

FLAGS
  --json    Print the complete result as JSON.

GLOBAL FLAGS
  --help, -h       Show help information
  --version, -v    Show version information

SUBCOMMANDS
  start        Start a Codex run in a new or prepared worktree.
  status       Show a run digest or one line per run in the current group.
  events       Read run events; text omits protocol chatter unless --verbose.
  steer        Send a change to the active turn.
  followup     Start a turn on an inactive run; refuses while answers are queued.
  interrupt    Interrupt the active turn or cancel start preflight.
  answer       Answer a question or correct an earlier answer with text or a file.
  defer        Release a pending question and leave the decision unanswered.
  result       Read the digest and latest available hand-off.
  archive      Archive an inactive run and print its archive path.
  wait         Wait for attention; default timeout is 60 minutes.
  doctor       Inspect config, Codex, repo hook trust and daemon state.
  guide        Print the agent workflow or a contract template.
  skill        Manage the bundled agent skill.
  daemon       Run the supervisor in the foreground (normally started automatically).
EXAMPLES
  # Read the agent delegation workflow
  foreman guide

  # Install the bundled agent entry point
  foreman skill install

Start here (agents): run foreman guide before your first delegation.
Use foreman guide <topic> for the workflow and foreman <command> --help for details.
```

### `foreman guide` (exit 0; first eight lines)

```text
The foreman CLI delegates coding tasks to Codex in isolated git worktrees and supervises them through a local daemon.
You write the contract, handle decisions, then review and run the repo's gate before committing or merging.

Before delegating:
- Read AGENTS.md, CLAUDE.md and .claude/delegate.md when present. Keep unresolved design decisions with the orchestrator; do small edits yourself.
- Have the foreman CLI and a signed-in Codex CLI on PATH, and a repo with a commit.
- On first use, open Codex in the main checkout, trust the project if asked and approve its project hooks in /hooks. Run foreman doctor and read every probe even on exit 0.
- Read CODEX_HOME/models_cache.json (default ~/.codex/models_cache.json) and choose a visible model. Use the same literal model for start and the contract's review command; replace gpt-6.1-sol in this example if needed.
```

### `foreman doctor` (exit 0; home path replaced with `~`)

```text
foreman 0.1.0 (darwin, compiled: true)
foreman on PATH is this binary: true
Codex executable: codex
Config: ok
Config file: ~/.foreman/config.json
Home: ~/.foreman
Home permissions: ok
Codex: 0.166.0
Protocol matches: true
Logged in: true
Repo hooks:
  pre_tool_use:0:0  trusted
  pre_tool_use:1:0  trusted
  foreman start will accept runs here (hook trust).
Daemon: running 0.1.0 (pid 66898)
Daemon build: 72dc6e10bec56853bc2794f97c04135e046480252d856a91555f0b6ec92265af
Daemon build matches this CLI: true
```

### `codex --version`, `foreman --version`, `git --version`, `bun --version` (each exit 0)

```text
codex-cli 0.166.0
foreman v0.1.0
git version 2.56.0
1.4.2
```

### `codex --help` (exit 0)

```text
Codex CLI

If no subcommand is specified, options will be forwarded to the interactive CLI.

Usage: codex [OPTIONS] [PROMPT]
       codex [OPTIONS] <COMMAND> [ARGS]

Commands:
  agents            Browse all agent sessions on the shared local app-server daemon
  exec              Run Codex non-interactively [aliases: e]
  review            Run a code review non-interactively
  login             Manage login
  logout            Remove stored authentication credentials
  mcp               Manage external MCP servers for Codex
  plugin            Manage Codex plugins
  app-server        [experimental] Run the app server or related tooling
  remote-control    [experimental] Manage the app-server daemon with remote control enabled
  app               Launch the Desktop app (opens the app installer if missing)
  completion        Generate shell completion scripts
  update            Update Codex to the latest version
  doctor            Diagnose local Codex installation, config, auth, and runtime health
  sandbox           Run commands within a Codex-provided sandbox
  debug             Debugging tools
  apply             Apply the latest diff produced by Codex agent as a `git apply` to your local
                    working tree [aliases: a]
  resume            Resume a previous interactive session (picker by default; use --last to continue
                    the most recent)
  queue             Queue a message for an existing session
  archive           Archive a saved session by id or session name
  delete            Permanently delete a saved session by id or session name
  migrate-rollouts  Inspect or migrate legacy local sessions to paginated thread history
  migrate-nfs-db    [experimental] Migrate configured SQLite databases to DELETE mode in place
  unarchive         Unarchive a saved session by id or session name
  fork              Fork a previous interactive session (picker by default; use --last to fork the
                    most recent)
  cloud             [EXPERIMENTAL] Browse tasks from Codex Cloud and apply changes locally
  exec-server       [EXPERIMENTAL] Run the standalone exec-server service
  features          Inspect feature flags
  help              Print this message or the help of the given subcommand(s)

Arguments:
  [PROMPT]
          Optional user prompt to start the session

Options:
  -c, --config <key=value>
          Override a configuration value that would otherwise be loaded from `~/.codex/config.toml`.
          Use a dotted path (`foo.bar.baz`) to override nested values. The `value` portion is parsed
          as TOML. If it fails to parse as TOML, the raw string is used as a literal.

          Examples: - `-c model="o3"` - `-c 'sandbox_permissions=["disk-full-read-access"]'` - `-c
          shell_environment_policy.inherit=all`

      --enable <FEATURE>
          Enable a feature (repeatable). Equivalent to `-c features.<name>=true`

      --disable <FEATURE>
          Disable a feature (repeatable). Equivalent to `-c features.<name>=false`

      --remote <ADDR>
          Connect the TUI to a remote app server endpoint.

          Accepted forms: `ws://host:port`, `wss://host:port`, `unix://`, or `unix://PATH`.

      --remote-auth-token-env <ENV_VAR>
          Name of the environment variable containing the bearer token to send to a remote app
          server websocket

      --strict-config
          Error out when config.toml contains fields that are not recognized by this version of
          Codex

  -i, --image <FILE>...
          Optional image(s) to attach to the initial prompt

  -m, --model <MODEL>
          Model the agent should use

      --oss
          Use open-source provider

      --local-provider <OSS_PROVIDER>
          Specify which local provider to use (lmstudio or ollama). If not specified with --oss,
          will use config default or show selection

  -p, --profile <CONFIG_PROFILE_V2>
          Layer $CODEX_HOME/<name>.config.toml on top of the base user config

  -s, --sandbox <SANDBOX_MODE>
          Select the sandbox policy to use when executing model-generated shell commands

          [possible values: read-only, workspace-write, danger-full-access]

      --approve-for-me
          Route approval requests through automatic review using the workspace-write sandbox

      --dangerously-bypass-approvals-and-sandbox
          Skip all confirmation prompts and execute commands without sandboxing. EXTREMELY
          DANGEROUS. Intended solely for running in environments that are externally sandboxed

      --dangerously-bypass-hook-trust
          Run enabled hooks without requiring persisted hook trust for this invocation. DANGEROUS.
          Intended only for automation that already vets hook sources

  -C, --cd <DIR>
          Tell the agent to use the specified directory as its working root

      --worktree
          Run the session in a new managed Git worktree

      --add-dir <DIR>
          Additional directories that should be writable alongside the primary workspace

  -a, --ask-for-approval <APPROVAL_POLICY>
          Configure when the model requires human approval before executing a command

          Possible values:
          - on-request: The model decides when to ask the user for approval
          - never:      Never ask for user approval Execution failures are immediately returned to
            the model

      --search
          Enable live web search. When enabled, the native Responses `web_search` tool is available
          to the model (no per‑call approval)

      --no-alt-screen
          Disable alternate screen mode

          Runs the TUI in inline mode, preserving terminal scrollback history.

      --no-daemon
          Run without the shared background server, even if it is already running

  -h, --help
          Print help (see a summary with '-h')

  -V, --version
          Print version
```

### `codex exec --help` (exit 0; selected help lines, omissions implicit)

```text
Run Codex non-interactively

Usage: codex exec [OPTIONS] [PROMPT]
       codex exec [OPTIONS] <COMMAND> [ARGS]

Commands:
  resume  Resume a previous session by id or pick the most recent with --last
  fork    Fork a previous session by id into a new session
  review  Run a code review against the current repository
  -s, --sandbox <SANDBOX_MODE>
          [possible values: read-only, workspace-write, danger-full-access]
      --approve-for-me
          Route approval requests through automatic review using the workspace-write sandbox
      --dangerously-bypass-approvals-and-sandbox
      --dangerously-bypass-hook-trust
          Run enabled hooks without requiring persisted hook trust for this invocation. DANGEROUS.
  -C, --cd <DIR>
      --worktree
          [possible values: standard, daybreak_blue, daybreak_red]
      --output-schema <FILE>
          [possible values: always, never, auto]
      --json
          Print events to stdout as JSONL
  -o, --output-last-message <FILE>
```

### `codex exec resume --help` (exit 0; selected help lines, omissions implicit)

```text
Resume a previous session by id or pick the most recent with --last

Usage: codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]

Arguments:
  [SESSION_ID]
          Conversation/session id (UUID) or thread name. UUIDs take precedence if it parses. If
          omitted, use --last to pick the most recent recorded session

      --dangerously-bypass-approvals-and-sandbox
      --dangerously-bypass-hook-trust
          Run enabled hooks without requiring persisted hook trust for this invocation. DANGEROUS.
      --worktree
          [possible values: standard, daybreak_blue, daybreak_red]
      --output-schema <FILE>
      --json
          Print events to stdout as JSONL
  -o, --output-last-message <FILE>
```

### `codex app-server --help` (exit 0; selected help lines, omissions implicit)

```text
[experimental] Run the app server or related tooling

Usage: codex app-server [OPTIONS] [COMMAND]

Commands:
  daemon                Manage the local app-server daemon
  proxy                 Proxy stdio bytes to the running app-server control socket
  generate-ts           [experimental] Generate TypeScript bindings for the app server protocol
  generate-json-schema  [experimental] Generate JSON Schema for the app server protocol
      --listen <URL>
          Transport endpoint URL. Supported values: `stdio://` (default), `unix://`, `unix://PATH`,
          [default: stdio://]
      --stdio
          Use stdio as the transport (equivalent to `--listen stdio://`)
          [possible values: capability-token, signed-bearer-token]
```

### `codex app-server daemon --help` (exit 0; selected help lines, omissions implicit)

```text
Manage the local app-server daemon

Usage: codex app-server daemon [OPTIONS] <COMMAND>

Commands:
  bootstrap               Install durable local app-server management for SSH-driven use
  start                   Start the local app server daemon if it is not already running
  restart                 Restart the local app server daemon
  update                  Update the daemon package (may interrupt running work)
```

### `codex agents --help` (exit 0; selected help lines, omissions implicit)

```text
Browse all agent sessions on the shared local app-server daemon

Usage: codex agents [OPTIONS]

Options:
  -c, --config <key=value>
          Override a configuration value that would otherwise be loaded from `~/.codex/config.toml`.
          Use a dotted path (`foo.bar.baz`) to override nested values. The `value` portion is parsed
          as TOML. If it fails to parse as TOML, the raw string is used as a literal.
  -C, --cd <DIR>
```

### `codex queue --help` (exit 0; selected help lines, omissions implicit)

```text
Queue a message for an existing session

Usage: codex queue [OPTIONS] --thread <THREAD> --message <TEXT>

Options:
      --thread <THREAD>
          Session UUID or exact session name

      --enable <FEATURE>
      --message <TEXT>
      --resume
          After queueing, try to resume the thread on the local daemon or selected --remote server.
          A failed resume produces a warning and the command still succeeds
  -C, --cd <DIR>
```

### `codex resume --help` (exit 0; selected help lines, omissions implicit)

```text
Resume a previous interactive session (picker by default; use --last to continue the most recent)

Usage: codex resume [OPTIONS] [SESSION_ID] [PROMPT]

Arguments:
  [SESSION_ID]
          Session id (UUID) or session name. UUIDs take precedence if it parses. If omitted, use
          --last to pick the most recent recorded session

      --include-non-interactive
  -s, --sandbox <SANDBOX_MODE>
          [possible values: read-only, workspace-write, danger-full-access]
      --approve-for-me
          Route approval requests through automatic review using the workspace-write sandbox
      --dangerously-bypass-approvals-and-sandbox
      --dangerously-bypass-hook-trust
          Run enabled hooks without requiring persisted hook trust for this invocation. DANGEROUS.
  -C, --cd <DIR>
      --worktree
  -a, --ask-for-approval <APPROVAL_POLICY>
          - on-request: The model decides when to ask the user for approval
          - never:      Never ask for user approval Execution failures are immediately returned to
      --no-daemon
          Run without the shared background server, even if it is already running
```

### `codex fork --help` (exit 0; selected help lines, omissions implicit)

```text
Fork a previous interactive session (picker by default; use --last to fork the most recent)

Usage: codex fork [OPTIONS] [SESSION_ID] [PROMPT]

Arguments:
  [SESSION_ID]
          Conversation/session id (UUID). When provided, forks this session. If omitted, use --last
          to pick the most recent recorded session

  -s, --sandbox <SANDBOX_MODE>
          [possible values: read-only, workspace-write, danger-full-access]
      --approve-for-me
          Route approval requests through automatic review using the workspace-write sandbox
      --dangerously-bypass-approvals-and-sandbox
      --dangerously-bypass-hook-trust
          Run enabled hooks without requiring persisted hook trust for this invocation. DANGEROUS.
  -C, --cd <DIR>
      --worktree
  -a, --ask-for-approval <APPROVAL_POLICY>
          - on-request: The model decides when to ask the user for approval
          - never:      Never ask for user approval Execution failures are immediately returned to
      --no-daemon
          Run without the shared background server, even if it is already running
```

### `codex login --help` (exit 0; selected help lines, omissions implicit)

```text
Manage login

Usage: codex login [OPTIONS] [COMMAND]

Commands:
  status  Show login status
  help    Print this message or the help of the given subcommand(s)

Options:
      --with-api-key
          Read the API key from stdin (e.g. `printenv OPENAI_API_KEY | codex login --with-api-key`)
      --with-access-token
          --with-access-token`)
      --device-auth
```

### `codex mcp-server --help` (exit 0; first six lines)

```text
Codex CLI

If no subcommand is specified, options will be forwarded to the interactive CLI.

Usage: codex [OPTIONS] [PROMPT]
       codex [OPTIONS] <COMMAND> [ARGS]
```

## Not verified

- A ChatGPT-only authentication guarantee for foreman was not established by its environment filter or login-status check, so writers must leave that guarantee out. (`src/codex/environment.ts:7`; `src/core/doctor.ts:205`) [not verified]
- General speed, cost or quality advantages over direct Codex or the OpenAI plugin were not established by the recorded four-run story. (`site/docs/PRODUCT.md:13`; `site/docs/PRODUCT.md:75`) [not verified]
- A working `codex mcp-server` command was not established because the installed root help omits it and its `--help` invocation only repeated root help. (local `codex --help`; local `codex mcp-server --help`) [not verified]
- The plugin README's installation steps and live commands were researched but not exercised on this machine. (<https://github.com/openai/codex-plugin-cc/blob/main/README.md#install>) [not verified]
- Guaranteed dynamic question-tool delivery after a foreman thread resume remains unverified and is explicitly conditional in the architecture. (`docs/architecture.md:33`) [not verified]
