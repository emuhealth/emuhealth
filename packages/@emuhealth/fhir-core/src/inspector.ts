import type { Hono, InspectorTab, Store } from "@emulators/core";
import { escapeAttr, escapeHtml, renderInspectorPage, renderJsonDetails } from "@emulators/core";
import { listExportJobs } from "./bulk.js";
import { getSmartConfig, listSmartTokens } from "./smart.js";
import { getFhirStore, type FhirResource } from "./store.js";

// FHIR inspector: browse resources, versions, recent changes, SMART clients and tokens, and Bulk Data exports.

const SERVICE_LABEL = "FHIR";
const LIMIT = 100;

const empty = (columns: number, text: string) =>
  `<tr><td colspan="${columns}"><div class="inspector-empty">${escapeHtml(text)}</div></td></tr>`;

function table(headers: string[], rows: string[], emptyText: string): string {
  return `<div class="inspector-scroll"><table class="inspector-table"><thead><tr>${headers
    .map((h) => `<th>${escapeHtml(h)}</th>`)
    .join(
      "",
    )}</tr></thead><tbody>${rows.length ? rows.join("") : empty(headers.length, emptyText)}</tbody></table></div>`;
}

function section(title: string, body: string): string {
  return `<div class="inspector-section"><h2>${escapeHtml(title)}</h2>${body}</div>`;
}

/** A short human label for a resource: a name, a code, or its status. */
export function resourceSummary(resource: FhirResource): string {
  const name =
    (resource.name as Array<{ text?: string; given?: string[]; family?: string }> | string | undefined) ?? undefined;
  if (typeof name === "string") return name;
  if (Array.isArray(name) && name[0])
    return name[0].text ?? [...(name[0].given ?? []), name[0].family].filter(Boolean).join(" ");
  for (const key of ["code", "vaccineCode", "medicationCodeableConcept", "type", "class"]) {
    const concept = resource[key] as
      | { text?: string; coding?: Array<{ display?: string; code?: string }>; display?: string }
      | undefined;
    if (concept && typeof concept === "object" && !Array.isArray(concept)) {
      const label = concept.text ?? concept.coding?.[0]?.display ?? concept.coding?.[0]?.code ?? concept.display;
      if (label) return label;
    }
  }
  return typeof resource.status === "string" ? resource.status : "";
}

export function registerFhirInspector(app: Hono<any>, store: Store, options: { path: string; base: string }): void {
  const { path, base } = options;
  const link = (params: Record<string, string>) => `${path}?${new URLSearchParams(params)}`;
  const tabs: InspectorTab[] = [
    { id: "resources", label: "Resources", href: link({ tab: "resources" }) },
    { id: "changes", label: "Recent changes", href: link({ tab: "changes" }) },
    { id: "smart", label: "SMART", href: link({ tab: "smart" }) },
    { id: "exports", label: "Exports", href: link({ tab: "exports" }) },
  ];

  function resourcesTab(type?: string, id?: string): string {
    const fhir = getFhirStore(store);
    if (type && id) {
      const current = fhir.find(type, id);
      const versions = fhir.listHistory({ type, id }).entries;
      const versionDetails = versions
        .map((h) =>
          h.resource
            ? renderJsonDetails(`Version ${h.version_id} (${h.method}, ${h.last_updated})`, h.resource)
            : `<div class="inspector-detail">Version ${h.version_id}: deleted ${escapeHtml(h.last_updated)}</div>`,
        )
        .join("");
      return (
        section(
          `${type}/${id}`,
          `<p><a href="${escapeAttr(link({ tab: "resources", type }))}">Back to ${escapeHtml(type)}</a> · <a href="${escapeAttr(`${base}/${type}/${id}`)}">JSON</a></p>${
            current
              ? renderJsonDetails("Current version", current, true)
              : '<p class="empty">This resource is deleted.</p>'
          }`,
        ) + section(`History (${versions.length})`, versionDetails || '<p class="empty">No versions.</p>')
      );
    }
    if (type) {
      const resources = fhir.listCurrent(type);
      const rows = resources
        .slice(0, LIMIT)
        .map(
          (r) =>
            `<tr><td><a href="${escapeAttr(link({ tab: "resources", type, id: r.id! }))}">${escapeHtml(r.id!)}</a></td><td>${escapeHtml(
              resourceSummary(r),
            )}</td><td>${escapeHtml(String(r.meta?.versionId ?? ""))}</td><td>${escapeHtml(String(r.meta?.lastUpdated ?? ""))}</td></tr>`,
        );
      const more =
        resources.length > LIMIT ? `<p class="empty">Showing the first ${LIMIT} of ${resources.length}.</p>` : "";
      return section(
        `${type} (${resources.length})`,
        `<p><a href="${escapeAttr(link({ tab: "resources" }))}">All types</a></p>${table(["Id", "Summary", "Version", "Last updated"], rows, `No ${type} resources`)}${more}`,
      );
    }
    const counts = new Map<string, { count: number; last: string }>();
    for (const r of fhir.listAllCurrent()) {
      const entry = counts.get(r.resourceType) ?? { count: 0, last: "" };
      entry.count++;
      const updated = String(r.meta?.lastUpdated ?? "");
      if (updated > entry.last) entry.last = updated;
      counts.set(r.resourceType, entry);
    }
    const rows = [...counts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([t, { count, last }]) =>
          `<tr><td><a href="${escapeAttr(link({ tab: "resources", type: t }))}">${escapeHtml(t)}</a></td><td>${count}</td><td>${escapeHtml(last)}</td></tr>`,
      );
    const total = [...counts.values()].reduce((sum, c) => sum + c.count, 0);
    return section(`Resources (${total})`, table(["Type", "Count", "Last updated"], rows, "The FHIR store is empty"));
  }

  function changesTab(): string {
    const { entries } = getFhirStore(store).listHistory({ count: LIMIT });
    const rows = entries.map(
      (h) =>
        `<tr><td>${escapeHtml(h.last_updated)}</td><td>${escapeHtml(h.method)}</td><td><a href="${escapeAttr(
          link({ tab: "resources", type: h.resource_type, id: h.fhir_id }),
        )}">${escapeHtml(`${h.resource_type}/${h.fhir_id}`)}</a></td><td>${h.version_id}</td></tr>`,
    );
    return section(`Recent changes`, table(["Time", "Method", "Resource", "Version"], rows, "No changes yet"));
  }

  function smartTab(): string {
    const clients = getSmartConfig(store).clients ?? [];
    const clientRows = clients.map((client) => {
      const kind = client.jwks || client.jwks_uri ? "asymmetric" : client.client_secret ? "confidential" : "public";
      return `<tr><td>${escapeHtml(client.client_id)}</td><td><span class="badge">${kind}</span></td><td>${escapeHtml(
        (client.redirect_uris ?? []).join(", "),
      )}</td><td>${escapeHtml(client.scope ?? "any")}</td></tr>`;
    });
    const tokens = listSmartTokens(store);
    const tokenRows = tokens.map(
      (t) =>
        `<tr><td>${escapeHtml(`${t.token.slice(0, 8)}...`)}</td><td>${t.kind}</td><td>${escapeHtml(t.clientId)}</td><td>${escapeHtml(
          t.scope,
        )}</td><td>${escapeHtml(t.patient ?? "")}</td><td>${escapeHtml(t.fhirUser ?? "")}</td><td>${
          t.expiresAt === Number.MAX_SAFE_INTEGER ? "never" : escapeHtml(new Date(t.expiresAt).toISOString())
        }</td></tr>`,
    );
    const mode = getSmartConfig(store).required
      ? "Tokens are required on every FHIR request."
      : "Requests without a token have full access.";
    return (
      section(
        `Registered clients (${clients.length})`,
        `<p>${escapeHtml(clients.length ? "Only these clients can authorize." : "No clients registered: any client_id and redirect_uri is accepted.")} ${escapeHtml(mode)}</p>${table(
          ["Client", "Type", "Redirect URIs", "Allowed scope"],
          clientRows,
          "No registered clients",
        )}`,
      ) +
      section(
        `Live tokens (${tokens.length})`,
        table(["Token", "Kind", "Client", "Scope", "Patient", "fhirUser", "Expires"], tokenRows, "No live tokens"),
      )
    );
  }

  function exportsTab(): string {
    const jobs = listExportJobs(store);
    const rows = jobs.map(
      (j) =>
        `<tr><td>${escapeHtml(j.id.slice(0, 8))}</td><td>${escapeHtml(j.transactionTime)}</td><td>${escapeHtml(
          j.request,
        )}</td><td>${escapeHtml(
          Object.entries(j.counts)
            .map(([t, n]) => `${t} ${n}`)
            .join(", "),
        )}</td><td><a href="${escapeAttr(`${base}/$export-status/${j.id}`)}">manifest</a></td></tr>`,
    );
    return section(
      `Bulk Data exports (${jobs.length})`,
      table(["Job", "Started", "Request", "Files", ""], rows, "No exports"),
    );
  }

  app.get(path, (c) => {
    const tab = c.req.query("tab") ?? "resources";
    const body =
      tab === "changes"
        ? changesTab()
        : tab === "smart"
          ? smartTab()
          : tab === "exports"
            ? exportsTab()
            : resourcesTab(c.req.query("type"), c.req.query("id"));
    return c.html(
      renderInspectorPage(
        "FHIR inspector",
        tabs,
        tabs.some((t) => t.id === tab) ? tab : "resources",
        body,
        SERVICE_LABEL,
      ),
    );
  });
}
