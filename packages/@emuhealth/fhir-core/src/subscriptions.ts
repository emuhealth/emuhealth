import { randomUUID } from "node:crypto";
import type { Store } from "@emulators/core";
import type { GuardedOperations } from "./operations.js";
import { parseSearch, runSearch } from "./search.js";
import { getFhirStore, type FhirResource, type FhirStore } from "./store.js";
import { getFhirVersion } from "./version.js";

// Topic-based FHIR Subscriptions with rest-hook delivery (decision 0022): R5 Subscriptions, and on R4B the R4 shaped
// Subscription of the Subscriptions R5 Backport IG. Writes through the API (not seeding or imports) are matched against
// each active Subscription's SubscriptionTopic and filters, and notification Bundles are POSTed to its endpoint.

const BACKPORT = "http://hl7.org/fhir/uv/subscriptions-backport/StructureDefinition";

export type Interaction = "create" | "update" | "delete";

interface ParsedSubscription {
  id: string;
  topic: string;
  endpoint: string;
  content: "empty" | "id-only" | "full-resource";
  headers: Record<string, string>;
  /** Filters as search parameters per resource type ("" applies to every type). */
  filters: Array<{ resourceType: string; param: string; value: string }>;
}

export interface SubscriptionDelivery {
  subscription: string;
  type: "handshake" | "event-notification";
  endpoint: string;
  status: number | "error";
  eventNumber?: number;
  focus?: string;
  time: string;
  error?: string;
}

interface SubscriptionState {
  events: Map<string, number>;
  deliveries: SubscriptionDelivery[];
  pending: Set<Promise<unknown>>;
}

const states = new WeakMap<Store, SubscriptionState>();
const stateOf = (store: Store): SubscriptionState => {
  let state = states.get(store);
  if (!state) states.set(store, (state = { events: new Map(), deliveries: [], pending: new Set() }));
  return state;
};

/** Deliveries made so far, newest last (for tests and the inspector). */
export const subscriptionDeliveries = (store: Store): SubscriptionDelivery[] => [...stateOf(store).deliveries];

/** Resolves when every delivery started so far has finished. */
export async function subscriptionsIdle(store: Store): Promise<void> {
  const state = stateOf(store);
  while (state.pending.size) await Promise.allSettled([...state.pending]);
}

const typeOf = (resource: string) => resource.replace(/^.*\/StructureDefinition\//, "");

function parseSubscription(r: FhirResource, r4b: boolean): ParsedSubscription | undefined {
  const s = r as Record<string, any>;
  if (r4b) {
    const channel = s.channel ?? {};
    if (channel.type !== "rest-hook" || !channel.endpoint) return undefined;
    const filters = (s._criteria?.extension ?? [])
      .filter((e: any) => e.url === `${BACKPORT}/backport-filter-criteria`)
      .flatMap((e: any) => {
        const [type, query] = String(e.valueString).split("?");
        return [...new URLSearchParams(query ?? "")].map(([param, value]) => ({ resourceType: type, param, value }));
      });
    const content =
      channel._payload?.extension?.find((e: any) => e.url === `${BACKPORT}/backport-payload-content`)?.valueCode ??
      "id-only";
    const headers = Object.fromEntries(
      (channel.header ?? []).map((h: string) => [
        h.slice(0, h.indexOf(":")).trim(),
        h.slice(h.indexOf(":") + 1).trim(),
      ]),
    );
    return { id: s.id, topic: s.criteria, endpoint: channel.endpoint, content, headers, filters };
  }
  if (s.channelType?.code !== "rest-hook" || !s.endpoint) return undefined;
  return {
    id: s.id,
    topic: s.topic,
    endpoint: s.endpoint,
    content: s.content ?? "empty",
    headers: Object.fromEntries((s.parameter ?? []).map((p: any) => [p.name, p.value])),
    filters: (s.filterBy ?? []).map((f: any) => ({
      resourceType: f.resourceType ?? "",
      param: f.filterParameter,
      value: f.value,
    })),
  };
}

function matches(fhir: FhirStore, resource: FhirResource, params: Array<[string, string]>): boolean {
  if (!params.length) return true;
  const ctx = {
    resolve: (t: string, id: string) => fhir.find(t, id) ?? undefined,
    listCurrent: (t: string) => fhir.listCurrent(t),
  };
  return runSearch([resource], parseSearch(resource.resourceType, params), ctx).matches.length === 1;
}

function statusResource(
  r4b: boolean,
  sub: ParsedSubscription,
  type: "handshake" | "event-notification" | "query-status",
  base: string,
  count: number,
  event?: { number: number; focus: string },
): FhirResource {
  const n = (value: number) => (r4b ? String(value) : value);
  return {
    resourceType: "SubscriptionStatus",
    status: "active",
    type,
    eventsSinceSubscriptionStart: n(count),
    ...(event
      ? {
          notificationEvent: [
            { eventNumber: n(event.number), timestamp: new Date().toISOString(), focus: { reference: event.focus } },
          ],
        }
      : {}),
    subscription: { reference: `${base}/Subscription/${sub.id}` },
    topic: sub.topic,
  };
}

function bundle(status: FhirResource, focus?: { fullUrl: string; resource?: FhirResource }): FhirResource {
  return {
    resourceType: "Bundle",
    id: randomUUID(),
    type: "subscription-notification",
    timestamp: new Date().toISOString(),
    entry: [{ fullUrl: `urn:uuid:${randomUUID()}`, resource: status }, ...(focus ? [focus] : [])],
  };
}

function deliver(
  store: Store,
  sub: ParsedSubscription,
  body: FhirResource,
  record: Omit<SubscriptionDelivery, "status" | "time" | "endpoint" | "subscription">,
): Promise<number | "error"> {
  const state = stateOf(store);
  const done = (async (): Promise<number | "error"> => {
    const time = new Date().toISOString();
    try {
      const res = await fetch(sub.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/fhir+json", ...sub.headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      state.deliveries.push({ subscription: sub.id, endpoint: sub.endpoint, status: res.status, time, ...record });
      return res.status;
    } catch (error) {
      state.deliveries.push({
        subscription: sub.id,
        endpoint: sub.endpoint,
        status: "error",
        time,
        error: (error as Error).message,
        ...record,
      });
      return "error";
    }
  })();
  state.pending.add(done);
  void done.finally(() => state.pending.delete(done));
  return done;
}

/** Handshake a requested Subscription and set it active, or error when the endpoint does not accept it. */
function activate(store: Store, base: string, resource: FhirResource): void {
  const r4b = getFhirVersion(store) === "4.3.0";
  const sub = parseSubscription(resource, r4b);
  if (!sub) return;
  void deliver(store, sub, bundle(statusResource(r4b, sub, "handshake", base, 0)), { type: "handshake" }).then(
    (status) => {
      const fhir = getFhirStore(store);
      const current = fhir.find("Subscription", sub.id);
      if (!current || current.status !== "requested") return;
      const ok = typeof status === "number" && status >= 200 && status < 300;
      fhir.update("Subscription", sub.id, { ...current, status: ok ? "active" : "error" });
    },
  );
}

/** Notify the active Subscriptions whose topic and filters match a write. */
export function notifySubscriptions(
  store: Store,
  base: string,
  interaction: Interaction,
  resource: FhirResource,
): void {
  const version = getFhirVersion(store);
  if (version === "4.0.1") return;
  if (resource.resourceType === "Subscription") {
    if (interaction !== "delete" && resource.status === "requested") activate(store, base, resource);
    return;
  }
  const r4b = version === "4.3.0";
  const fhir = getFhirStore(store);
  const state = stateOf(store);
  for (const raw of fhir.listCurrent("Subscription")) {
    if (raw.status !== "active") continue;
    const sub = parseSubscription(raw, r4b);
    if (!sub) continue;
    const topic = fhir.listCurrent("SubscriptionTopic").find((t) => t.url === sub.topic) as
      | Record<string, any>
      | undefined;
    const triggered = (topic?.resourceTrigger ?? []).some((trigger: any) => {
      if (typeOf(trigger.resource ?? "") !== resource.resourceType) return false;
      if (trigger.supportedInteraction && !trigger.supportedInteraction.includes(interaction)) return false;
      const current = trigger.queryCriteria?.current as string | undefined;
      if (current && interaction !== "delete")
        return matches(fhir, resource, [...new URLSearchParams(current.split("?")[1] ?? current)]);
      return true;
    });
    if (!triggered) continue;
    const filters = sub.filters.filter((f) => !f.resourceType || f.resourceType === resource.resourceType);
    if (
      interaction !== "delete" &&
      !matches(
        fhir,
        resource,
        filters.map((f) => [f.param, f.value]),
      )
    )
      continue;
    const count = (state.events.get(sub.id) ?? 0) + 1;
    state.events.set(sub.id, count);
    const focus = `${base}/${resource.resourceType}/${resource.id}`;
    const status = statusResource(r4b, sub, "event-notification", base, count, { number: count, focus });
    const entry =
      sub.content === "full-resource" && interaction !== "delete"
        ? { fullUrl: focus, resource }
        : sub.content === "id-only"
          ? { fullUrl: focus }
          : undefined;
    void deliver(store, sub, bundle(status, entry), { type: "event-notification", eventNumber: count, focus });
  }
}

/**
 * Operations that notify Subscriptions after each successful write. With a queue, notifications wait there until
 * the caller flushes it, so a transaction that rolls back sends none.
 */
export function notifyingOperations(
  store: Store,
  base: string,
  ops: GuardedOperations,
  queue?: Array<() => void>,
): GuardedOperations {
  const notify = (interaction: Interaction, resource: FhirResource) => {
    const send = () => notifySubscriptions(store, base, interaction, resource);
    if (queue) queue.push(send);
    else send();
  };
  return {
    ...ops,
    create(type, body, id) {
      const result = ops.create(type, body, id);
      notify("create", result.resource);
      return result;
    },
    update(type, id, body, ifMatch) {
      const result = ops.update(type, id, body, ifMatch);
      notify(result.created ? "create" : "update", result.resource);
      return result;
    },
    patch(type, id, operations, ifMatch) {
      const result = ops.patch(type, id, operations, ifMatch);
      notify("update", result.resource);
      return result;
    },
    delete(type, id, ifMatch) {
      const before = getFhirStore(store).find(type, id);
      const result = ops.delete(type, id, ifMatch);
      if (before && result.versionId) notify("delete", before);
      return result;
    },
  };
}

/** The SubscriptionStatus Bundle for GET /Subscription/:id/$status. */
export function subscriptionStatusBundle(store: Store, base: string, resource: FhirResource): FhirResource {
  const r4b = getFhirVersion(store) === "4.3.0";
  const sub = parseSubscription(resource, r4b) ?? {
    id: resource.id!,
    topic: (resource.topic ?? resource.criteria) as string,
    endpoint: "",
    content: "empty" as const,
    headers: {},
    filters: [],
  };
  const status = statusResource(r4b, sub, "query-status", base, stateOf(store).events.get(sub.id) ?? 0);
  return {
    resourceType: "Bundle",
    id: randomUUID(),
    type: "searchset",
    total: 1,
    entry: [
      {
        fullUrl: `urn:uuid:${randomUUID()}`,
        resource: { ...status, status: resource.status },
        search: { mode: "match" },
      },
    ],
  };
}
