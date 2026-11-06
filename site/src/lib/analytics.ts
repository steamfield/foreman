// The only module that imports posthog-js. Analytics is off, and the SDK never
// loads, while the key is empty: the normal state in dev, tests, CI and sandboxes.
// The caller reads env and passes it in, so this module never touches import.meta.env.
import type { ConsentState, ConsentStore } from "@steamfield/ui/consent";
import type { PostHog, PostHogInterface } from "posthog-js";
import type { EventName, EventProperties, EventProps } from "./events";

export type AnalyticsConfig = {
  key: string | undefined;
  // Empty means PostHog US cloud.
  host?: string | undefined;
  consent: ConsentStore;
};
type Loader = () => Promise<{ default: Pick<PostHog, "init"> }>;
type Client = Pick<
  PostHogInterface,
  "capture" | "identify" | "reset" | "get_explicit_consent_status"
>;
type Call = (client: Client) => void;

const QUEUE_LIMIT = 50;
let client: Client | undefined;
let queue: Call[] | undefined;
let warned = false;
let unsubscribe: (() => void) | undefined;

function applyConsent(
  posthog: PostHogInterface,
  consent: ConsentState,
  key: string,
) {
  if (consent === "granted") {
    if (posthog.get_explicit_consent_status() !== "granted")
      posthog.opt_in_capturing();
    posthog.set_config({ capture_heatmaps: true });
    posthog.startSessionRecording();
  } else {
    posthog.stopSessionRecording();
    posthog.set_config({ capture_heatmaps: false });
    // Pending plus opt_out_capturing_by_default means cookieless, with no
    // PostHog consent record to shadow the shared store on the next page.
    posthog.clear_opt_in_out_capturing();
    // posthog-js 1.447 leaves its tab identity behind on withdrawal.
    // Remove these until the SDK clears them itself (covered by the real-SDK test).
    try {
      sessionStorage.removeItem(`ph_${key}_window_id`);
      sessionStorage.removeItem(`ph_${key}_primary_window_exists`);
    } catch (error) {
      console.warn("analytics: could not clear session storage", error);
    }
  }
}

function send(call: Call) {
  if (client) return call(client);
  if (!queue) return; // Not initialized, or no key: a silent no-op.
  if (queue.length >= QUEUE_LIMIT) {
    if (!warned) console.warn("analytics: queue full, dropping calls");
    warned = true;
    return;
  }
  queue.push(call);
}

export async function initAnalytics(
  config: AnalyticsConfig,
  load: Loader = () => import("posthog-js"),
): Promise<void> {
  const { key } = config;
  if (!key || typeof window === "undefined" || queue || client) return;
  queue = [];
  let posthog: Pick<PostHog, "init">;
  try {
    ({ default: posthog } = await load());
  } catch (error) {
    console.warn("analytics: SDK load failed; analytics disabled", error);
    queue = undefined;
    return;
  }
  try {
    posthog.init(key, {
      api_host: config.host || "https://us.i.posthog.com",
      // Explicit options below win over the defaults snapshot.
      defaults: "latest",
      person_profiles: "identified_only",
      capture_pageview: "history_change",
      cookieless_mode: "on_reject",
      opt_out_capturing_by_default: true,
      persistence: "localStorage+cookie",
      cross_subdomain_cookie: true,
      opt_out_capturing_persistence_type: "cookie",
      autocapture: false,
      capture_dead_clicks: false,
      capture_exceptions: false,
      disable_surveys: true,
      disable_conversations: true,
      disable_product_tours: true,
      // Remote console capture bypasses before_send and its site/consent guards.
      __extensionClasses: { logs: undefined },
      disable_session_recording: true,
      capture_heatmaps: false,
      session_recording: {
        maskAllInputs: true,
        maskTextSelector: "[data-ph-mask]",
        recordHeaders: false,
        recordBody: false,
      },
      before_send: (event) => {
        if (!event) return null;
        if (
          ["$$heatmap", "$dead_click", "$snapshot"].includes(event.event) &&
          client?.get_explicit_consent_status() !== "granted"
        )
          return null;
        return {
          ...event,
          properties: { ...event.properties, site: "forman" },
        };
      },
      loaded: (instance) => {
        applyConsent(instance, config.consent.getState(), key);
        const stopConsent = config.consent.subscribe((state) =>
          applyConsent(instance, state, key),
        );
        // A restored page retains the store's cached state. A sibling site's
        // withdrawal has already cleared PostHog's shared consent cookie.
        const onRestore = (event: PageTransitionEvent) => {
          if (
            event.persisted &&
            instance.get_explicit_consent_status() !== "granted"
          )
            applyConsent(instance, null, key);
        };
        window.addEventListener("pageshow", onRestore);
        unsubscribe = () => {
          stopConsent();
          window.removeEventListener("pageshow", onRestore);
        };
        client = instance;
        for (const call of queue ?? []) call(instance);
        queue = undefined;
      },
    });
  } catch (error) {
    console.warn(
      "analytics: SDK initialization failed; analytics disabled",
      error,
    );
    queue = undefined;
    client = undefined;
    unsubscribe?.();
    unsubscribe = undefined;
  }
}

export function track<E extends EventName>(
  event: E,
  props: EventProperties[E],
): void {
  send((c) => c.capture(event, props));
}

// Identify by internal id only, after sign-in.
export function identify(id: string, traits?: EventProps): void {
  send((c) => c.identify(id, traits));
}

// Call on sign-out.
export function reset(): void {
  send((c) => c.reset());
}

// Tests only: forget the client and the queue between cases.
export function resetAnalyticsForTests(): void {
  unsubscribe?.();
  unsubscribe = undefined;
  client = undefined;
  queue = undefined;
  warned = false;
}
