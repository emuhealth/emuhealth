import { createHash } from "node:crypto";

export type FieldType = "ID" | "String" | "Number" | "Boolean" | "Date" | "DateTime" | "Picklist" | "Object";

export interface FieldDef {
  name: string;
  label: string;
  type: FieldType;
  required?: boolean;
  editable?: boolean;
  unique?: boolean;
  /** Referenced object for Object fields. */
  object?: string;
  /** Allowed values for Picklist fields. */
  picklist?: string[];
  multi?: boolean;
}

export interface ObjectDef {
  name: string;
  label: string;
  label_plural: string;
  prefix: string;
  fields: FieldDef[];
}

export type VaultRecord = Record<string, unknown> & { id: string };

const SYSTEM_FIELDS: FieldDef[] = [
  { name: "id", label: "ID", type: "ID", required: true, editable: false, unique: true },
  { name: "name__v", label: "Name", type: "String", required: true, editable: true },
  { name: "status__v", label: "Status", type: "Picklist", picklist: ["active__v", "inactive__v"], editable: true },
  { name: "external_id__v", label: "External ID", type: "String", editable: true, unique: true },
  { name: "created_by__v", label: "Created By", type: "Number", editable: false },
  { name: "created_date__v", label: "Created Date", type: "DateTime", editable: false },
  { name: "modified_by__v", label: "Last Modified By", type: "Number", editable: false },
  { name: "modified_date__v", label: "Last Modified Date", type: "DateTime", editable: false },
];

export const OBJECTS: ObjectDef[] = [
  {
    name: "product__v",
    label: "Product",
    label_plural: "Products",
    prefix: "00P",
    fields: [
      ...SYSTEM_FIELDS,
      { name: "generic_name__c", label: "Generic Name", type: "String", editable: true },
      {
        name: "therapeutic_area__c",
        label: "Therapeutic Area",
        type: "Picklist",
        editable: true,
        picklist: ["cardiology__c", "oncology__c", "neurology__c", "endocrinology__c"],
      },
    ],
  },
  {
    name: "country__v",
    label: "Country",
    label_plural: "Countries",
    prefix: "00C",
    fields: [...SYSTEM_FIELDS, { name: "abbreviation__c", label: "Abbreviation", type: "String", editable: true }],
  },
  {
    name: "study__v",
    label: "Study",
    label_plural: "Studies",
    prefix: "0ST",
    fields: [
      ...SYSTEM_FIELDS,
      { name: "product__v", label: "Product", type: "Object", object: "product__v", editable: true },
      {
        name: "study_phase__v",
        label: "Study Phase",
        type: "Picklist",
        editable: true,
        picklist: ["phase_1__v", "phase_2__v", "phase_3__v", "phase_4__v"],
      },
      {
        name: "study_status__v",
        label: "Study Status",
        type: "Picklist",
        editable: true,
        picklist: ["planning__v", "enrolling__v", "closed_to_enrollment__v", "completed__v"],
      },
      { name: "planned_enrollment__c", label: "Planned Enrollment", type: "Number", editable: true },
    ],
  },
  {
    name: "site__v",
    label: "Study Site",
    label_plural: "Study Sites",
    prefix: "0SI",
    fields: [
      ...SYSTEM_FIELDS,
      { name: "study__v", label: "Study", type: "Object", object: "study__v", required: true, editable: true },
      { name: "country__v", label: "Country", type: "Object", object: "country__v", editable: true },
      {
        name: "site_status__v",
        label: "Site Status",
        type: "Picklist",
        editable: true,
        picklist: ["selected__v", "initiated__v", "active__v", "closed__v"],
      },
      { name: "principal_investigator__c", label: "Principal Investigator", type: "String", editable: true },
    ],
  },
];

/** A Vault style record ID: the object prefix and 12 more characters, stable for a key. */
export function recordId(prefix: string, key: string): string {
  const n = BigInt(`0x${createHash("sha256").update(key).digest("hex").slice(0, 15)}`) % 10n ** 12n;
  return `${prefix}${n.toString().padStart(12, "0")}`;
}

const CREATED = "2026-01-05T15:00:00.000Z";

function record(def: ObjectDef, key: string, fields: Record<string, unknown>): VaultRecord {
  return {
    id: recordId(def.prefix, key),
    status__v: ["active__v"],
    external_id__v: null,
    created_by__v: 1,
    created_date__v: CREATED,
    modified_by__v: 1,
    modified_date__v: CREATED,
    ...fields,
  };
}

export function generateRecords(): Record<string, VaultRecord[]> {
  const [product, country, study, site] = OBJECTS;
  const products = [
    record(product, "p1", {
      name__v: "Synthexa",
      generic_name__c: "synthexamab",
      therapeutic_area__c: ["oncology__c"],
    }),
    record(product, "p2", {
      name__v: "Placebrin",
      generic_name__c: "placebrinostat",
      therapeutic_area__c: ["cardiology__c"],
    }),
    record(product, "p3", {
      name__v: "Fictorol",
      generic_name__c: "fictorolimus",
      therapeutic_area__c: ["neurology__c"],
    }),
  ];
  const countries = [
    ["United States", "US"],
    ["Canada", "CA"],
    ["Germany", "DE"],
    ["Japan", "JP"],
  ].map(([name, abbr]) => record(country, `c-${abbr}`, { name__v: name, abbreviation__c: abbr }));
  const studies = [
    record(study, "s1", {
      name__v: "EMU-101",
      product__v: products[0].id,
      study_phase__v: ["phase_2__v"],
      study_status__v: ["enrolling__v"],
      planned_enrollment__c: 240,
    }),
    record(study, "s2", {
      name__v: "EMU-202",
      product__v: products[1].id,
      study_phase__v: ["phase_3__v"],
      study_status__v: ["planning__v"],
      planned_enrollment__c: 900,
    }),
    record(study, "s3", {
      name__v: "EMU-303",
      product__v: products[2].id,
      study_phase__v: ["phase_1__v"],
      study_status__v: ["completed__v"],
      planned_enrollment__c: 48,
    }),
  ];
  const sites: VaultRecord[] = [];
  const investigators = ["Dr. Dana Example", "Dr. Lee Sample", "Dr. Rowan Placeholder", "Dr. Kai Fictional"];
  studies.forEach((s, i) => {
    for (let n = 0; n < 3; n++) {
      const c = countries[(i + n) % countries.length];
      sites.push(
        record(site, `site-${i}-${n}`, {
          name__v: `${s.name__v}-${String(n + 1).padStart(3, "0")}`,
          study__v: s.id,
          country__v: c.id,
          site_status__v: [i === 2 ? "closed__v" : n === 2 ? "selected__v" : "active__v"],
          principal_investigator__c: investigators[(i + n) % investigators.length],
        }),
      );
    }
  });
  return {
    [product.name]: products,
    [country.name]: countries,
    [study.name]: studies,
    [site.name]: sites,
  };
}

export interface VaultDocument {
  id: number;
  versions: DocumentVersion[];
}

export type DocumentVersion = Record<string, unknown> & {
  major_version_number__v: number;
  minor_version_number__v: number;
  file?: { name: string; type: string; content: Buffer };
};

export const DOCUMENT_PROPERTIES: FieldDef[] = [
  { name: "id", label: "Document ID", type: "ID", editable: false },
  { name: "version_id", label: "Version ID", type: "String", editable: false },
  { name: "name__v", label: "Name", type: "String", required: true, editable: true },
  { name: "title__v", label: "Title", type: "String", editable: true },
  { name: "type__v", label: "Type", type: "String", required: true, editable: true },
  { name: "subtype__v", label: "Subtype", type: "String", editable: true },
  { name: "classification__v", label: "Classification", type: "String", editable: true },
  { name: "lifecycle__v", label: "Lifecycle", type: "String", required: true, editable: true },
  { name: "status__v", label: "Status", type: "String", editable: false },
  { name: "document_number__v", label: "Document Number", type: "String", editable: false },
  { name: "major_version_number__v", label: "Major Version", type: "Number", editable: false },
  { name: "minor_version_number__v", label: "Minor Version", type: "Number", editable: false },
  { name: "product__v", label: "Product", type: "Object", object: "product__v", multi: true, editable: true },
  { name: "study__v", label: "Study", type: "Object", object: "study__v", multi: true, editable: true },
  { name: "format__v", label: "Format", type: "String", editable: false },
  { name: "filename__v", label: "File Name", type: "String", editable: false },
  { name: "size__v", label: "Size", type: "Number", editable: false },
  { name: "md5checksum__v", label: "MD5 Checksum", type: "String", editable: false },
  { name: "binder__v", label: "Binder", type: "Boolean", editable: false },
  { name: "created_by__v", label: "Created By", type: "Number", editable: false },
  { name: "document_creation_date__v", label: "Created Date", type: "DateTime", editable: false },
  { name: "version_modified_date__v", label: "Version Modified Date", type: "DateTime", editable: false },
];

export function fileFields(file: { name: string; type: string; content: Buffer }) {
  return {
    format__v: file.type,
    filename__v: file.name,
    size__v: file.content.length,
    md5checksum__v: createHash("md5").update(file.content).digest("hex"),
  };
}

export function generateDocuments(records: Record<string, VaultRecord[]>): VaultDocument[] {
  const studies = records.study__v ?? [];
  const products = records.product__v ?? [];
  const specs = [
    {
      type: "Trial Master File",
      subtype: "Trial Management",
      classification: "Protocol",
      title: "Clinical Study Protocol",
      status: "Approved",
    },
    {
      type: "Trial Master File",
      subtype: "Trial Management",
      classification: "Investigator's Brochure",
      title: "Investigator's Brochure",
      status: "Approved",
    },
    {
      type: "Trial Master File",
      subtype: "Subject Documents",
      classification: "Informed Consent Form",
      title: "Informed Consent Form Template",
      status: "Draft",
    },
  ];
  const docs: VaultDocument[] = [];
  let id = 1;
  for (const study of studies)
    for (const spec of specs) {
      const product = products.find((p) => p.id === study.product__v);
      const content = Buffer.from(
        `SYNTHETIC DOCUMENT. Not a real ${spec.title.toLowerCase()}.\n\n${spec.title}\nStudy ${study.name__v}${product ? `, ${product.name__v}` : ""}\n`,
      );
      const file = {
        name: `${String(study.name__v).toLowerCase()}-${spec.classification.toLowerCase().replace(/[^a-z]+/g, "-")}.txt`,
        type: "text/plain",
        content,
      };
      const approved = spec.status === "Approved";
      docs.push({
        id,
        versions: [
          {
            name__v: `${study.name__v} ${spec.title}`,
            title__v: `${spec.title} for ${study.name__v}`,
            type__v: spec.type,
            subtype__v: spec.subtype,
            classification__v: spec.classification,
            lifecycle__v: "General Lifecycle",
            status__v: spec.status,
            document_number__v: `VV-SYN-${String(id).padStart(5, "0")}`,
            major_version_number__v: approved ? 1 : 0,
            minor_version_number__v: approved ? 0 : 1,
            product__v: product ? [product.id] : [],
            study__v: [study.id],
            binder__v: false,
            created_by__v: 1,
            document_creation_date__v: CREATED,
            version_modified_date__v: CREATED,
            ...fileFields(file),
            file,
          },
        ],
      });
      id++;
    }
  return docs;
}
