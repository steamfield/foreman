export const site = {
  title: "forman",
  description: "Delegate coding tasks to Codex from Claude Code.",
  url: "https://forman.steamfield.io",
  author: "Riley Hilliard",
  image: "/default-og.svg",
  nav: [{ label: "Home", href: "/" }],
};

if (!["https:", "http:"].includes(new URL(site.url).protocol)) {
  throw new Error("Set site.url to an absolute HTTP or HTTPS production URL.");
}
