// The event catalog. track() accepts only these names. Name events object_verb in
// the past tense (post_shared) and keep properties snake_case. No SDK import here,
// so server code and tests can read the catalog without loading posthog-js.
export const Events = {
  installCopied: "install_copied",
  sectionViewed: "section_viewed",
  commandTab: "command_tab",
  demoReplayed: "demo_replayed",
} as const;

export type EventName = (typeof Events)[keyof typeof Events];

// Property values are flat scalars: never free text a user typed, emails or tokens.
export type EventProperties = {
  install_copied: { method: string };
  section_viewed: { id: string };
  command_tab: { name: string };
  demo_replayed: { id: string };
};
export type EventProps = Record<string, string | number | boolean | null>;
