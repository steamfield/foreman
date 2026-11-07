export const site = {
  title: "foreman",
  description:
    "foreman makes Codex models available to Claude Code as subagents: Claude plans and reviews, and hands implementation to sol, terra or astra, each in its own git worktree. Claude answers their questions and reviews the diff before anything is committed.",
  metaDescription:
    "Claude Code runs Codex as subagents in a git worktree with foreman. Hand over a contract, answer questions, and review the changes before anything is committed.",
  url: "https://foreman.steamfield.io",
  author: "Riley Hilliard",
  image: "/og/index.webp",
  repo: "https://github.com/steamfield/foreman",
  readme: "https://github.com/steamfield/foreman#readme",
  npm: "https://www.npmjs.com/package/@steamfield/foreman",
  nav: [
    { label: "How it works", href: "/#lifecycle" },
    { label: "Commands", href: "/#commands" },
    { label: "Blog", href: "/blog" },
    { label: "GitHub", href: "https://github.com/steamfield/foreman" },
  ],
};

if (!["https:", "http:"].includes(new URL(site.url).protocol)) {
  throw new Error("Set site.url to an absolute HTTP or HTTPS production URL.");
}
