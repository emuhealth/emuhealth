// Synthetic Benchling tenant: a project, folders, schemas, a registry, DNA and AA sequences, notebook entries, and
// assay results. Sequences are random bases from a seeded generator, not real constructs.

export type Obj = Record<string, unknown>;

export interface Tenant {
  users: Obj[];
  projects: Obj[];
  folders: Obj[];
  registries: Obj[];
  entitySchemas: Obj[];
  assayResultSchemas: Obj[];
  dnaSequences: Obj[];
  aaSequences: Obj[];
  entries: Obj[];
  assayResults: Obj[];
  tasks: Obj[];
  events: Obj[];
  counter: number;
}

export interface GenerateOptions {
  /** PRNG seed. Default 1. */
  seed?: number;
  /** DNA sequences, 0 to 500. Default 10. */
  dnaSequences?: number;
}

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const USER = { id: "ent_SYNUSER1", handle: "synthetic-scientist", name: "Synthetic Scientist" };
const at = (day: number) => new Date(Date.parse("2025-01-06T15:00:00Z") + day * 86_400_000).toISOString();

const AMINO = "ACDEFGHIKLMNPQRSTVWY";

export function generateTenant(options: GenerateOptions = {}): Tenant {
  const seed = options.seed ?? 1;
  const count = options.dnaSequences ?? 10;
  if (!Number.isInteger(seed)) throw new Error("benchling.generate.seed must be an integer");
  if (!Number.isInteger(count) || count < 0 || count > 500)
    throw new Error("benchling.generate.dnaSequences must be an integer from 0 to 500");
  const random = prng(seed);
  const int = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));
  const bases = (n: number) => Array.from({ length: n }, () => "ACGT"[int(0, 3)]).join("");
  const residues = (n: number) => `M${Array.from({ length: n - 1 }, () => AMINO[int(0, AMINO.length - 1)]).join("")}`;

  const project = { id: "src_SYNPROJ1", name: "Synthetic Research", owner: USER, archiveRecord: null };
  const folders = [
    { id: "lib_SYNSEQS1", name: "Sequences", parentFolderId: null, projectId: project.id, archiveRecord: null },
    { id: "lib_SYNNOTE1", name: "Notebook", parentFolderId: null, projectId: project.id, archiveRecord: null },
  ];
  const registry = { id: "src_SYNREG01", name: "Synthetic Registry" };
  const plasmid = {
    id: "ts_SYNPLSM1",
    name: "Plasmid",
    type: "dna_sequence",
    prefix: "PLS",
    registryId: registry.id,
    fieldDefinitions: [
      { id: "tsf_SYNRES01", name: "Resistance", type: "text", isMulti: false, isRequired: false },
      { id: "tsf_SYNBKB01", name: "Backbone", type: "text", isMulti: false, isRequired: false },
    ],
    archiveRecord: null,
  };
  const protein = {
    id: "ts_SYNPROT1",
    name: "Protein",
    type: "aa_sequence",
    prefix: "PRT",
    registryId: registry.id,
    fieldDefinitions: [{ id: "tsf_SYNTAG01", name: "Tag", type: "text", isMulti: false, isRequired: false }],
    archiveRecord: null,
  };
  const absorbance = {
    id: "assaysch_SYNABS1",
    name: "Plate Reader Absorbance",
    type: "assay_result",
    fieldDefinitions: [
      { id: "tsf_SYNSMP01", name: "sample", type: "entity_link", isMulti: false, isRequired: true },
      { id: "tsf_SYNWAV01", name: "wavelength_nm", type: "integer", isMulti: false, isRequired: true },
      { id: "tsf_SYNABS01", name: "absorbance", type: "float", isMulti: false, isRequired: true },
    ],
    archiveRecord: null,
  };
  const field = (value: unknown, type: string) => ({
    value,
    type,
    isMulti: false,
    displayValue: value === null ? null : String(value),
  });

  const meta = (kind: string, n: number, day: number) => ({
    creator: USER,
    createdAt: at(day),
    modifiedAt: at(day + 1),
    archiveRecord: null,
    webURL: `https://benchling.emuhealth.local/${kind}/${n}`,
  });

  const dnaSequences: Obj[] = [];
  for (let n = 1; n <= count; n++) {
    const sequence = bases(int(60, 240));
    const id = `seq_SYN${String(n).padStart(5, "0")}`;
    dnaSequences.push({
      id,
      name: `pSYN-${String(n).padStart(3, "0")}`,
      bases: sequence,
      length: sequence.length,
      isCircular: n % 2 === 1,
      folderId: folders[0].id,
      schema: { id: plasmid.id, name: plasmid.name },
      fields: {
        Resistance: field(n % 2 ? "Kanamycin" : "Ampicillin", "text"),
        Backbone: field("pSYN backbone", "text"),
      },
      customFields: {},
      aliases: [],
      annotations: [
        {
          name: "synthetic feature",
          start: 0,
          end: Math.min(30, sequence.length),
          strand: 1,
          type: "misc_feature",
          color: "#85DAE9",
        },
      ],
      primers: [],
      translations: [],
      entityRegistryId: n <= Math.ceil(count / 2) ? `PLS${String(n).padStart(3, "0")}` : null,
      registryId: n <= Math.ceil(count / 2) ? registry.id : null,
      registrationOrigin: null,
      ...meta("seq", n, n),
    });
  }

  const aaSequences: Obj[] = Array.from({ length: 5 }, (_, i) => {
    const amino = residues(int(40, 120));
    return {
      id: `prtn_SYN${String(i + 1).padStart(5, "0")}`,
      name: `SYN-Protein-${i + 1}`,
      aminoAcids: amino,
      length: amino.length,
      folderId: folders[0].id,
      schema: { id: protein.id, name: protein.name },
      fields: { Tag: field(i % 2 ? "His6" : "FLAG", "text") },
      customFields: {},
      aliases: [],
      annotations: [],
      entityRegistryId: null,
      registryId: null,
      ...meta("prtn", i + 1, i + 2),
    };
  });

  const entries: Obj[] = Array.from({ length: 3 }, (_, i) => ({
    id: `etr_SYN${String(i + 1).padStart(5, "0")}`,
    name: `Synthetic experiment ${i + 1}`,
    displayId: `EXP${String(i + 1).padStart(3, "0")}`,
    folderId: folders[1].id,
    authors: [USER],
    schema: null,
    fields: {},
    customFields: {},
    days: [
      {
        date: at(i * 7).slice(0, 10),
        notes: [
          {
            type: "text",
            text: `Synthetic notebook entry ${i + 1}. Transformed pSYN-00${i + 1} and measured absorbance.`,
            links: [],
          },
        ],
      },
    ],
    reviewRecord: null,
    ...meta("etr", i + 1, i * 7),
  }));

  const assayResults: Obj[] = Array.from({ length: Math.min(20, count * 2) }, (_, i) => {
    const sample = dnaSequences[i % dnaSequences.length];
    return {
      id: `5e7e0000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
      schema: { id: absorbance.id, name: absorbance.name },
      projectId: project.id,
      fields: {
        sample: field(sample.id, "entity_link"),
        wavelength_nm: field(600, "integer"),
        absorbance: field(Number((0.05 + random() * 1.5).toFixed(3)), "float"),
      },
      isReviewed: false,
      creator: USER,
      createdAt: at(10 + i),
      modifiedAt: at(10 + i),
      archiveRecord: null,
    };
  });

  return {
    users: [USER],
    projects: [project],
    folders,
    registries: [registry],
    entitySchemas: [plasmid, protein],
    assayResultSchemas: [absorbance],
    dnaSequences,
    aaSequences,
    entries,
    assayResults,
    tasks: [],
    events: [],
    counter: 0,
  };
}
