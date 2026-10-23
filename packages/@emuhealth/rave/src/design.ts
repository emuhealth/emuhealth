import { createHash } from "node:crypto";

// The CRF design every synthetic study uses, and the generated subjects.

export interface ItemDef {
  oid: string;
  name: string;
  label: string;
  dataType: "text" | "integer" | "float" | "date";
  codeList?: string;
  length?: number;
}

export interface FormDef {
  oid: string;
  name: string;
  repeating: boolean;
  items: ItemDef[];
}

export interface EventDef {
  oid: string;
  name: string;
  forms: string[];
}

export const CODE_LISTS: Record<string, Array<[string, string]>> = {
  SEX: [
    ["M", "Male"],
    ["F", "Female"],
    ["U", "Unknown"],
  ],
  NY: [
    ["N", "No"],
    ["Y", "Yes"],
  ],
  AESEV: [
    ["MILD", "Mild"],
    ["MODERATE", "Moderate"],
    ["SEVERE", "Severe"],
  ],
};

export const FORMS: FormDef[] = [
  {
    oid: "DM",
    name: "Demographics",
    repeating: false,
    items: [
      { oid: "DM.BRTHDAT", name: "BRTHDAT", label: "Date of birth", dataType: "date" },
      { oid: "DM.SEX", name: "SEX", label: "Sex", dataType: "text", codeList: "SEX", length: 1 },
      { oid: "DM.HEIGHT", name: "HEIGHT", label: "Height (cm)", dataType: "float" },
    ],
  },
  {
    oid: "VS",
    name: "Vital Signs",
    repeating: false,
    items: [
      { oid: "VS.VSDAT", name: "VSDAT", label: "Date of measurement", dataType: "date" },
      { oid: "VS.SYSBP", name: "SYSBP", label: "Systolic blood pressure (mmHg)", dataType: "integer" },
      { oid: "VS.DIABP", name: "DIABP", label: "Diastolic blood pressure (mmHg)", dataType: "integer" },
      { oid: "VS.PULSE", name: "PULSE", label: "Pulse (beats/min)", dataType: "integer" },
      { oid: "VS.WEIGHT", name: "WEIGHT", label: "Weight (kg)", dataType: "float" },
    ],
  },
  {
    oid: "AE",
    name: "Adverse Events",
    repeating: true,
    items: [
      { oid: "AE.AETERM", name: "AETERM", label: "Adverse event", dataType: "text", length: 200 },
      { oid: "AE.AESTDAT", name: "AESTDAT", label: "Start date", dataType: "date" },
      { oid: "AE.AESEV", name: "AESEV", label: "Severity", dataType: "text", codeList: "AESEV", length: 8 },
      { oid: "AE.AESER", name: "AESER", label: "Serious", dataType: "text", codeList: "NY", length: 1 },
    ],
  },
];

export const EVENTS: EventDef[] = [
  { oid: "SCREENING", name: "Screening", forms: ["DM", "VS"] },
  { oid: "BASELINE", name: "Baseline", forms: ["VS"] },
  { oid: "WEEK4", name: "Week 4", forms: ["VS"] },
  { oid: "LOGS", name: "Logs", forms: ["AE"] },
];

export const formDef = (oid: string) => FORMS.find((f) => f.oid === oid);
export const eventDef = (oid: string) => EVENTS.find((e) => e.oid === oid);

export interface ItemGroupRecord {
  repeatKey: string;
  items: Record<string, string>;
}
export interface FormRecord {
  formOid: string;
  repeatKey: string;
  groups: ItemGroupRecord[];
  modified: string;
}
export interface EventRecord {
  eventOid: string;
  repeatKey: string;
  forms: FormRecord[];
}
export interface Subject {
  key: string;
  uuid: string;
  site: string;
  number: number;
  active: boolean;
  deleted: boolean;
  events: EventRecord[];
}
export interface Site {
  oid: string;
  name: string;
  number: string;
}
export interface Audit {
  id: number;
  subjectUuid: string;
  eventOid: string;
  eventRepeatKey: string;
  formOid: string;
  formRepeatKey: string;
  groupRepeatKey: string;
  itemOid?: string;
  value?: string;
  subCategory: string;
  user: string;
  site: string;
  time: string;
}
export interface StudyEnv {
  project: string;
  env: string;
  versionOid: string;
  description: string;
  sites: Site[];
  subjects: Subject[];
  audits: Audit[];
}

/** A UUID shaped value, stable for a key. */
export function stableUuid(key: string): string {
  const h = createHash("sha256").update(key).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`.toUpperCase();
}

function prng(seed: string) {
  let state = parseInt(createHash("sha256").update(seed).digest("hex").slice(0, 8), 16) || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0xffffffff;
  };
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

export const STUDIES = [
  { project: "EMU-101", description: "Synthetic phase 2 oncology study", versionOid: "1001" },
  { project: "EMU-202", description: "Synthetic phase 3 cardiology study", versionOid: "2001" },
];

export interface GenerateOptions {
  /** Subjects per Prod environment (default 8). */
  subjects?: number;
  seed?: string;
}

export function generateStudies(options: GenerateOptions = {}): StudyEnv[] {
  const count = options.subjects ?? 8;
  if (!Number.isInteger(count) || count < 0 || count > 500)
    throw new Error("rave.generate.subjects must be an integer from 0 to 500");
  const seed = options.seed ?? "emuhealth";
  const out: StudyEnv[] = [];
  STUDIES.forEach((study, s) => {
    for (const env of ["Prod", "UAT"]) {
      const rand = prng(`${seed}|${study.project}|${env}`);
      const sites: Site[] = [1, 2, 3].map((n) => ({
        oid: `SYN-SITE-${s + 1}0${n}`,
        name: `Synthetic Research Site ${s + 1}0${n}`,
        number: `${s + 1}0${n}`,
      }));
      const audits: Audit[] = [];
      const n = env === "Prod" ? count : Math.min(2, count);
      const subjects: Subject[] = [];
      for (let i = 0; i < n; i++) {
        const site = sites[i % sites.length];
        const key = `${site.number}-${String(Math.floor(i / sites.length) + 1).padStart(3, "0")}`;
        const screened = new Date(Date.UTC(2026, 0, 5 + i * 3));
        const day = (offset: number) => iso(new Date(screened.getTime() + offset * 86400000));
        const vitals = (offset: number): Record<string, string> => ({
          "VS.VSDAT": day(offset),
          "VS.SYSBP": String(105 + Math.floor(rand() * 35)),
          "VS.DIABP": String(65 + Math.floor(rand() * 20)),
          "VS.PULSE": String(58 + Math.floor(rand() * 30)),
          "VS.WEIGHT": (55 + rand() * 40).toFixed(1),
        });
        const stamp = `${day(0)}T15:00:00`;
        const events: EventRecord[] = [
          {
            eventOid: "SCREENING",
            repeatKey: "1",
            forms: [
              {
                formOid: "DM",
                repeatKey: "1",
                modified: stamp,
                groups: [
                  {
                    repeatKey: "1",
                    items: {
                      "DM.BRTHDAT": iso(
                        new Date(
                          Date.UTC(
                            1950 + Math.floor(rand() * 50),
                            Math.floor(rand() * 12),
                            1 + Math.floor(rand() * 28),
                          ),
                        ),
                      ),
                      "DM.SEX": rand() < 0.5 ? "F" : "M",
                      "DM.HEIGHT": (150 + rand() * 45).toFixed(1),
                    },
                  },
                ],
              },
              { formOid: "VS", repeatKey: "1", modified: stamp, groups: [{ repeatKey: "1", items: vitals(0) }] },
            ],
          },
        ];
        if (i % 4 !== 3)
          events.push({
            eventOid: "BASELINE",
            repeatKey: "1",
            forms: [
              {
                formOid: "VS",
                repeatKey: "1",
                modified: `${day(14)}T15:00:00`,
                groups: [{ repeatKey: "1", items: vitals(14) }],
              },
            ],
          });
        if (i % 2 === 0)
          events.push({
            eventOid: "WEEK4",
            repeatKey: "1",
            forms: [
              {
                formOid: "VS",
                repeatKey: "1",
                modified: `${day(42)}T15:00:00`,
                groups: [{ repeatKey: "1", items: vitals(42) }],
              },
            ],
          });
        if (i % 3 === 1)
          events.push({
            eventOid: "LOGS",
            repeatKey: "1",
            forms: [
              {
                formOid: "AE",
                repeatKey: "1",
                modified: `${day(20)}T15:00:00`,
                groups: [
                  {
                    repeatKey: "1",
                    items: { "AE.AETERM": "Headache", "AE.AESTDAT": day(18), "AE.AESEV": "MILD", "AE.AESER": "N" },
                  },
                  {
                    repeatKey: "2",
                    items: { "AE.AETERM": "Nausea", "AE.AESTDAT": day(20), "AE.AESEV": "MODERATE", "AE.AESER": "N" },
                  },
                ],
              },
            ],
          });
        const subject: Subject = {
          key,
          uuid: stableUuid(`${seed}|${study.project}|${env}|${key}`),
          site: site.oid,
          number: i + 1,
          active: true,
          deleted: false,
          events,
        };
        subjects.push(subject);
        for (const e of events)
          for (const f of e.forms)
            for (const g of f.groups)
              for (const [itemOid, value] of Object.entries(g.items))
                audits.push({
                  id: audits.length + 1,
                  subjectUuid: subject.uuid,
                  eventOid: e.eventOid,
                  eventRepeatKey: e.repeatKey,
                  formOid: f.formOid,
                  formRepeatKey: f.repeatKey,
                  groupRepeatKey: g.repeatKey,
                  itemOid,
                  value,
                  subCategory: "Entered",
                  user: "syn.coordinator",
                  site: site.oid,
                  time: f.modified,
                });
      }
      out.push({ ...study, env, sites, subjects, audits });
    }
  });
  return out;
}
