export const site = {
  title: "foreman",
  description:
    "foreman lets Claude Code hand coding tasks to Codex, each in its own git worktree, and supervise them while they run. Claude answers Codex's questions and reviews the diff before anything is committed.",
  url: "https://foreman.steamfield.io",
  author: "Riley Hilliard",
  image: "/default-og.svg",
  repo: "https://github.com/steamfield/foreman",
  readme: "https://github.com/steamfield/foreman#readme",
  npm: "https://www.npmjs.com/package/@steamfield/foreman",
  nav: [
    { label: "How it works", href: "/#lifecycle" },
    { label: "Commands", href: "/#commands" },
    { label: "GitHub", href: "https://github.com/steamfield/foreman" },
  ],
};

if (!["https:", "http:"].includes(new URL(site.url).protocol)) {
  throw new Error("Set site.url to an absolute HTTP or HTTPS production URL.");
}
