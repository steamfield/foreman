// @vitest-environment happy-dom
import { createConsentStore, mountConsentBanner } from "@steamfield/ui/consent";
import { PostHog, type CaptureResult } from "posthog-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as analytics from "./analytics";
import { Events } from "./events";

const entry = import.meta.glob<string>("../layouts/BaseLayout.astro", {
  query: "?raw",
  import: "default",
  eager: true,
});
const entrySource = Object.values(entry)[0] ?? "";
const disposers: (() => void)[] = [];

function offlineSdk() {
  const sdk = new PostHog();
  const seen: CaptureResult[] = [];
  const init = sdk.init.bind(sdk);
  vi.spyOn(sdk, "init").mockImplementation((key, config) =>
    init(key, {
      ...config,
      opt_out_useragent_filter: true,
      advanced_disable_flags: true,
      before_send: (event) => {
        const result = config?.before_send;
        if (typeof result !== "function")
          throw new Error("Missing before_send");
        const outgoing = result(event);
        if (outgoing) seen.push(outgoing);
        return null; // Observe real SDK events without sending them.
      },
    }),
  );
  return { sdk, seen, load: vi.fn(async () => ({ default: sdk })) };
}

function config(key = "phc_test") {
  const consent = createConsentStore({ domain: "steamfield.io" });
  disposers.push(consent.destroy);
  return { key, host: "http://127.0.0.1:9", consent };
}

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
  document.cookie = "sf-consent=; Max-Age=0; Path=/";
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  analytics.resetAnalyticsForTests();
  for (const dispose of disposers.splice(0)) dispose();
  document.body.innerHTML = "";
  Reflect.deleteProperty(window, "_POSTHOG_REMOTE_CONFIG");
  vi.restoreAllMocks();
});

describe("analytics", () => {
  it("never loads the SDK without a key and calls remain silent", async () => {
    const { load, seen } = offlineSdk();
    const warn = vi.spyOn(console, "warn");
    await analytics.initAnalytics(config(""), load);
    analytics.track(Events.installCopied, { method: "npm" });
    analytics.identify("user_1");
    analytics.reset();
    expect(load).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("replays queued events in order and stamps every event with the site", async () => {
    const { load, seen } = offlineSdk();
    const pending = analytics.initAnalytics(config(), load);
    analytics.track(Events.sectionViewed, { id: "first" });
    analytics.track(Events.commandTab, { name: "run" });
    await pending;
    analytics.track(Events.demoReplayed, { id: "second" });
    expect(
      seen
        .filter((event) => !event.event.startsWith("$"))
        .map((event) => event.event),
    ).toEqual(["section_viewed", "command_tab", "demo_replayed"]);
    expect(seen.every((event) => event.properties.site === "foreman")).toBe(
      true,
    );
    expect(
      seen.find((event) => event.event === "section_viewed")?.properties.id,
    ).toBe("first");
  });

  it("drops calls beyond the buffer limit and warns once", async () => {
    const { load, seen } = offlineSdk();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const pending = analytics.initAnalytics(config(), load);
    for (let i = 0; i < 60; i++)
      analytics.track(Events.sectionViewed, { id: String(i) });
    await pending;
    expect(
      seen.filter((event) => event.event === "section_viewed"),
    ).toHaveLength(50);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("drops queued calls on a failed load, warns once and allows a clean retry", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const blocked = () => Promise.reject(new Error("blocked"));
    const settings = config();
    const pending = analytics.initAnalytics(settings, blocked);
    analytics.track(Events.sectionViewed, { id: "dropped" });
    await expect(pending).resolves.toBeUndefined();
    analytics.track(Events.sectionViewed, { id: "also-dropped" });
    const { load, seen } = offlineSdk();
    await analytics.initAnalytics(settings, load);
    expect(seen.some((event) => event.event === "section_viewed")).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("initializes once across repeated calls", async () => {
    const { load } = offlineSdk();
    const settings = config();
    await Promise.all([
      analytics.initAnalytics(settings, load),
      analytics.initAnalytics(settings, load),
    ]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("keeps pending and declined visitors cookieless; Accept enables recordings and heatmaps", async () => {
    const { sdk, load, seen } = offlineSdk();
    const settings = config();
    await analytics.initAnalytics(settings, load);
    expect(sdk.config.api_host).toBe("http://127.0.0.1:9");
    expect(sdk.config.cookieless_mode).toBe("on_reject");
    expect(sdk.config.capture_pageview).toBe("history_change");
    expect(sdk.config.autocapture).toBe(false);
    expect(sdk.config.disable_session_recording).toBe(true);
    expect(sdk.config.capture_heatmaps).toBe(false);
    expect(sdk.get_explicit_consent_status()).toBe("pending");
    sdk.capture("$$heatmap");
    expect(seen.some((event) => event.event === "$$heatmap")).toBe(false);

    disposers.push(
      mountConsentBanner(settings.consent, {
        delayMs: 0,
        privacyHref: "https://steamfield.io/privacy",
      }),
    );
    document
      .querySelector<HTMLButtonElement>('[data-part="consent-accept"]')
      ?.click();
    expect(settings.consent.getState()).toBe("granted");
    expect(sdk.get_explicit_consent_status()).toBe("granted");
    expect(sdk.config.disable_session_recording).toBe(false);
    expect(sdk.config.capture_heatmaps).toBe(true);
    sdk.capture("$$heatmap");
    expect(seen.some((event) => event.event === "$$heatmap")).toBe(true);
    expect(seen.every((event) => event.properties.site === "foreman")).toBe(
      true,
    );

    settings.consent.decline();
    expect(sdk.get_explicit_consent_status()).toBe("pending");
    expect(sdk.config.disable_session_recording).toBe(true);
    expect(sdk.config.capture_heatmaps).toBe(false);
    expect(document.cookie).not.toMatch(/ph_phc_test/);
    expect(Object.keys(localStorage).some((key) => key.startsWith("ph_"))).toBe(
      false,
    );
    expect(
      Object.keys(sessionStorage).some((key) => key.startsWith("ph_")),
    ).toBe(false);
    seen.length = 0;
    sdk.capture("$$heatmap");
    analytics.track(Events.installCopied, { method: "bun" });
    expect(seen.map((event) => event.event)).toEqual(["install_copied"]);
  });

  it("honors an existing shared consent choice before the first pageview", async () => {
    document.cookie = "sf-consent=granted; Path=/";
    const { sdk, load, seen } = offlineSdk();
    await analytics.initAnalytics(config(), load);
    expect(sdk.get_explicit_consent_status()).toBe("granted");
    expect(sdk.config.capture_heatmaps).toBe(true);
    expect(seen.some((event) => event.event === "$pageview")).toBe(true);
    expect(seen.every((event) => event.properties.site === "foreman")).toBe(
      true,
    );
  });
});

it("keeps remote console capture disabled before and after Accept", async () => {
  const { load } = offlineSdk();
  const settings = config();
  const info = console.info;
  Object.defineProperty(window, "_POSTHOG_REMOTE_CONFIG", {
    configurable: true,
    value: {
      phc_test: {
        config: { hasFeatureFlags: false, logs: { captureConsoleLogs: true } },
      },
    },
  });
  await analytics.initAnalytics(settings, load);
  expect(console.info).toBe(info);
  expect(document.querySelector('script[src*="/logs"]')).toBeNull();
  settings.consent.accept();
  expect(console.info).toBe(info);
  expect(document.querySelector('script[src*="/logs"]')).toBeNull();
});

it("withdraws recording and heatmaps when a cached page returns after a sibling decline", async () => {
  const { sdk, load, seen } = offlineSdk();
  const settings = config();
  settings.consent.accept();
  await analytics.initAnalytics(settings, load);
  document.cookie = "sf-consent=denied; Path=/";
  document.cookie = "__ph_opt_in_out_phc_test=; Max-Age=0; Path=/";
  expect(settings.consent.getState()).toBe("granted");
  seen.length = 0;
  sdk.capture("$$heatmap");
  expect(seen.some((event) => event.event === "$$heatmap")).toBe(false);
  const restored = new Event("pageshow");
  Object.defineProperty(restored, "persisted", { value: true });
  window.dispatchEvent(restored);
  expect(sdk.config.capture_heatmaps).toBe(false);
  expect(sdk.config.disable_session_recording).toBe(true);
  expect(Object.keys(sessionStorage).some((key) => key.startsWith("ph_"))).toBe(
    false,
  );
  analytics.track(Events.sectionViewed, { id: "restored" });
  expect(seen.some((event) => event.event === "section_viewed")).toBe(true);
  expect(
    seen.every(
      (event) =>
        event.properties.$cookieless_mode === true &&
        event.properties.site === "foreman",
    ),
  ).toBe(true);
});

it("BaseLayout gates analytics and the shared banner on the build key", () => {
  expect(entrySource).toMatch(
    /import\s*\{[^}]*\binitAnalytics\b[^}]*\}\s*from\s*["'][^"']*lib\/analytics["']/,
  );
  expect(entrySource).toMatch(/if \(key\)/);
  expect(entrySource).toMatch(/\binitAnalytics\(/);
  expect(entrySource).toMatch(
    /createConsentStore\(\{ domain: "steamfield.io" \}\)/,
  );
  expect(entrySource).toMatch(/mountConsentBanner\(consent/);
  expect(entrySource).toContain("https://steamfield.io/privacy");
});
