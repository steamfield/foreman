# Contract: write one blog article for the foreman site

You are working in a git worktree for an orchestrator who reviews and commits your work. Leave changes uncommitted and do not push. Ask through `ask_orchestrator` only when blocked; everything else goes in the hand-off.

## Goal

Write exactly one article, `site/src/content/blog/{{SLUG}}.mdx`, for the blog at `https://foreman.steamfield.io/blog`. The brief at the end gives the query, angle, outline and sources. Touch no other file.

## The product

foreman lets Claude Code hand coding tasks to OpenAI's Codex, each in its own git worktree, and supervise them through a local daemon: Claude writes a task contract, Codex implements, Claude answers Codex's questions, reads progress, then reviews the diff and commits. foreman never commits or merges itself. It drives `codex app-server` with the user's Codex CLI login. macOS and Linux, MIT licensed, `npm i -g @steamfield/foreman`. Everything else you say about it comes from the fact sheet.

## The reader

Someone who just typed the primary query into Google. They use Claude Code or Codex already, have a concrete problem, and have never heard of foreman. They leave the moment the article stops answering their question. Answer it first with what they already have (Claude Code, the Codex CLI, git); bring foreman in where those stop, as one option, plainly. When Codex or Claude Code already does something natively, say so and show it.

## Voice and structure

```sh
ce=$(ls -d "$HOME"/.claude/plugins/cache/*/ce/*/ | sort -V | tail -1)
```

- Read `${ce}skills/writer/SKILL.md`, then `${ce}skills/writer/references/educator.md` and `${ce}skills/writer/references/forbidden-patterns.md` in full. Write as the Educator persona.
- Read `${ce}skills/structuring-articles/SKILL.md` and `${ce}skills/structuring-articles/references/inverted-pyramid.md`. Inverted Pyramid: the answer to the query in the first two paragraphs, then detail in decreasing order of importance.
- Read `/Users/riley/Projects/opendata/.claude/skills/seo/SKILL.md` for title, description and heading rules (it was written for another site; apply the rules).
- Before handing off, check the draft line by line against forbidden-patterns.md and fix every hit. No em dashes. No emoji. Sentence-case headings. No marketing language, no claims of speed or cost savings.

## SEO rules

- `title` (at most 48 characters) carries the primary query or its core words near the front; the layout appends " | foreman".
- `headline` (optional, at most 110) is the h1; use it when the full query doesn't fit in the title.
- `description` (120 to 160 characters) answers the query in one sentence; it's the search snippet.
- The primary query or a close variant appears in the h1, in the first 100 words of the body, and in one H2.
- H2s are the follow-up questions people search (the brief gives them; reword slightly if needed). `##` and `###` only. No h1 in the body; start with the lede paragraph.
- After those placements, write naturally. Link anchors describe their target.

## Mechanics

{{ENGINE_API}}

- Code blocks are for commands and config the reader types. Never write foreman's output by hand; foreman output appears only through `CommandDemo`, which replays real recordings. Output of other tools only when you've captured it here or are certain it's accurate.
- MDX traps: a bare `<` or `{` in prose breaks the build (put it in backticks); no HTML comments (use `{/* */}`); use `CommandDemo` at most once.

## Length

Length follows the task: 900 to 1,800 words of prose (frontmatter, imports and code don't count). Stop when the reader's question is answered; don't pad.

## Facts policy

- Fact sheet: `site/docs/blog/facts.md` in this worktree. Every claim about foreman, Codex, Claude Code or git traces to a fact there. Facts tagged `[not verified]` stay out.
- Need something the sheet lacks? Verify it yourself: foreman from this repo's code (cite `path:line`), Codex from `codex <cmd> --help` here or an official OpenAI page, Claude Code from official Anthropic docs. List each in the hand-off with its source. If you can't source it, leave it out.
- Never say another tool can't do something unless a source says so.
- No invented numbers. Only measured numbers from the sheet, with their caveats.
- Don't overclaim foreman. State its limits where the brief notes them.

## Links

- Internal: `/` and `/#install` only (sibling posts don't exist in your worktree; the orchestrator adds cross-links later). The build fails on broken internal links.
- External: official docs only (developers.openai.com, learn.chatgpt.com, github.com/openai/..., code.claude.com, docs.anthropic.com, git-scm.com, foreman's GitHub README), and only URLs from the fact sheet or that you fetched and confirmed exist.

## Acceptance

From the worktree's `site/` directory:

```sh
make lint
make check
{{SCOPED_BUILD}}
```

All must pass. Don't run full `make build`, `make test` or `make e2e`; ten writers run at once and the orchestrator runs the full suite once. Then QA: `make dev PORT_WEB={{PORT}}` from `site/`, load `http://localhost:{{PORT}}/blog/{{SLUG}}` (curl or a small Playwright script), confirm the h1, TOC entries, CommandDemo if used, and measure the prose word count. Stop the server.

## Do not

- commit or push
- edit any file except `site/src/content/blog/{{SLUG}}.mdx`
- hand-write foreman output, invent numbers, or link sibling posts
- mention any repository other than foreman and official OpenAI/Anthropic/git ones

## Review before hand-off

Re-read the article once as the reader above, and once against forbidden-patterns.md. Fix what you find.

## Hand-off

Leave the file uncommitted and end with:

1. Summary: the angle in two sentences.
2. Keyword placement: quote the title, h1, the sentence in the first 100 words, and the H2 carrying the query.
3. Facts used: each product claim with its fact-sheet line or source.
4. Sources you added beyond the sheet, and claims you cut for lack of one.
5. Checks: each command and result; QA notes; word count.
6. Look closer at: the paragraphs you're least sure of.

---

# Brief

{{BRIEF}}
