# Before calling work done

Run `bun run check` (lint, typecheck, the vitest suite, then e2e, which builds the binary) and read the output. e2e is the only check of the compiled binary. CI also runs `bun run coverage`; `check` doesn't. Optional fragments may extend `check`.

- A clean exit code isn't a pass. Read the counts from every runner: a `-t` filter that matches nothing exits 0 with every test skipped.
- Run the real CLI, not only the tests: `bun run dev -- doctor`, `bun run dev -- doctor --json | jq`, and the command you changed. Each run appends to `logs/cli.jsonl` (one `command` line) and tees stderr to `logs/cli.log`.
- Check the contract by hand when a command changed: stdout holds only the result (`bun run dev -- <cmd> --json | jq`), a bad flag leaves stdout empty and exits 2 (`echo $?`).
- Build changes: `bun run build`, then `./dist/foreman --version` and `./dist/foreman doctor`.
- For any failure, read `logs/cli.jsonl` (structured; `jq -c 'select(.level == "error" or .level == "warn")' logs/cli.jsonl`) and `logs/cli.log` (the whole stderr) before guessing. Stop only processes you started.
- A green commit isn't a complete one: after a hook-running commit, check `git status` for files a hook rewrote and left unstaged.
- Don't report a cause you didn't observe. Quote the error output you're basing it on.
