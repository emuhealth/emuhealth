# 0022: FHIR Subscriptions

- Status: Accepted
- Date: 2026-10-24
- Refines: [0016](0016-fhir-r4b-and-r5.md)

## Context

Apps that react to EHR events (admissions, new results) use topic-based FHIR Subscriptions: R5 defines them in core, and the Subscriptions R5 Backport IG brings them to R4B with an R4 shaped Subscription. Testing those apps needs a server that delivers real notifications.

## Decision

- fhir-core supports topic-based Subscriptions with the `rest-hook` channel on R5 and R4B. R4 servers do not deliver notifications.
- Topics are SubscriptionTopic resources in the store. A topic's `resourceTrigger` entries match on resource type, `supportedInteraction` (create, update, delete), and `queryCriteria.current` as search parameters.
- R5 Subscriptions use `topic`, `channelType`, `endpoint`, `content`, `parameter` (sent as headers), and `filterBy`. On R4B, the backport shape uses `criteria` (the topic), `backport-filter-criteria` extensions, `channel.endpoint`, `channel.header`, and the `backport-payload-content` extension.
- A Subscription created with status `requested` gets a `handshake` notification. A `2xx` answer makes it `active`; anything else makes it `error`.
- Writes through the API, including Bundle entries, notify matching active Subscriptions with a `subscription-notification` Bundle: a SubscriptionStatus with the event number and focus, then the focus as `full-resource`, `id-only`, or nothing (`empty`). A transaction's notifications are sent only after it commits. Seeding and imports do not notify.
- `GET /Subscription/{id}/$status` returns the status with the event count.
- Delivery is a single attempt with a 10 second timeout. There are no retries, heartbeats, or websocket and email channels.

## Consequences

- Event-driven apps can be tested end to end against R5 and R4B servers.
- Delivery details (retries, heartbeats, other channels) can be added later without changing the topic and filter model.
