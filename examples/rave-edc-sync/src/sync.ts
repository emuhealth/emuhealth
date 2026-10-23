// Incremental EDC sync: replays new audit records onto a local snapshot and remembers where it stopped.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fetchAuditPage } from "./audit.ts";

export interface SyncOptions {
  raveUrl: string;
  username: string;
  password: string;
  /** Study and environment, for example EMU-101(Prod). */
  study: string;
  /** JSON file holding the cursor and the snapshot between runs. */
  statePath: string;
  perPage?: number;
}

export interface SyncState {
  nextStartId: number;
  /** subject -> "FOLDER/FORM/FIELD" -> value */
  subjects: Record<string, Record<string, string>>;
}

export function loadState(path: string): SyncState {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { nextStartId: 1, subjects: {} };
}

export async function sync(options: SyncOptions): Promise<{ applied: number; state: SyncState }> {
  const state = loadState(options.statePath);
  const auth = `Basic ${Buffer.from(`${options.username}:${options.password}`).toString("base64")}`;
  const params = new URLSearchParams({
    studyoid: options.study,
    startid: String(state.nextStartId),
    per_page: String(options.perPage ?? 500),
  });
  let url: string | undefined = `${options.raveUrl}/RaveWebServices/datasets/ClinicalAuditRecords.odm?${params}`;
  let applied = 0;
  while (url) {
    const page = await fetchAuditPage(url, auth);
    for (const record of page.records) {
      const fields = (state.subjects[record.subject] ??= {});
      const key = `${record.folder}/${record.form}/${record.field}`;
      if (record.category === "Removed") delete fields[key];
      else fields[key] = record.value;
      state.nextStartId = Math.max(state.nextStartId, record.sourceId + 1);
      applied++;
    }
    url = page.next;
  }
  // Save after every run so the next one starts after the last record seen.
  writeFileSync(options.statePath, JSON.stringify(state, null, 2));
  return { applied, state };
}
