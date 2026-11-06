export const site = {
  title: "forman",
  description:
    "forman lets Claude Code hand coding tasks to Codex in their own git worktrees and supervise them while they run: answer Codex's questions, steer it, and review the work before it lands.",
  url: "https://forman.steamfield.io",
  author: "Riley Hilliard",
  image: "/default-og.svg",
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
