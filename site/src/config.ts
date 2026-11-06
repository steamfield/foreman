export const site = {
  title: "forman",
  description:
    "forman makes Codex models available to Claude Code as subagents: Claude plans and reviews, and hands implementation to sol, terra or astra, each in its own git worktree. Claude answers their questions and reviews the diff before anything is committed.",
  url: "https://forman.steamfield.io",
  author: "Riley Hilliard",
  image: "/og/index.webp",
  repo: "https://github.com/steamfield/forman",
  readme: "https://github.com/steamfield/forman#readme",
  npm: "https://www.npmjs.com/package/@steamfield/forman",
  nav: [
    { label: "How it works", href: "/#lifecycle" },
    { label: "Commands", href: "/#commands" },
    { label: "GitHub", href: "https://github.com/steamfield/forman" },
  ],
};

if (!["https:", "http:"].includes(new URL(site.url).protocol)) {
  throw new Error("Set site.url to an absolute HTTP or HTTPS production URL.");
}
