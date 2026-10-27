import { syntheticPeople, type GenerateOptions } from "@emuhealth/fhir-core";
import { sha1, STATUS_APPROVED, type Code, type CodeName, type DocumentEntry, type Submission } from "./ebrim.js";

// Synthetic document sharing data: two text documents for each person of the shared population, registered in one
// submission set each. Identifiers use the 2.25 (UUID) OID arc, so they cannot collide with assigned OIDs.

export const ASSIGNING_AUTHORITY = "2.25.211144934573491648823315826212385512893";
export const REPOSITORY_ID = "2.25.106212425219263453271339394582217123742";
export const HOME_COMMUNITY_ID = "urn:oid:2.25.338474659226574913810834289214564431301";
const SOURCE_ID = "2.25.47390265413052113451981652405121651837";
const LOCAL_SCHEME = "2.25.159871361098541317962145631282981325641";

export const patientCx = (mrn: string) => `${mrn}^^^&${ASSIGNING_AUTHORITY}&ISO`;

const LOINC = "2.16.840.1.113883.6.1";
export const COMMON_CODES: Omit<Record<CodeName, Code>, "classCode" | "typeCode"> = {
  confidentialityCode: { code: "N", scheme: "2.16.840.1.113883.5.25", display: "normal" },
  formatCode: {
    code: "urn:ihe:iti:xds:2017:mimeTypeSufficient",
    scheme: "1.3.6.1.4.1.19376.1.2.3",
    display: "mimeType Sufficient",
  },
  healthcareFacilityTypeCode: { code: "OF", scheme: "2.16.840.1.113883.5.111", display: "Outpatient facility" },
  practiceSettingCode: { code: "general-medicine", scheme: LOCAL_SCHEME, display: "General medicine" },
};

const KINDS = [
  { code: "34133-9", display: "Summary of episode note", title: "Visit summary" },
  { code: "11506-3", display: "Progress note", title: "Progress note" },
];

export function seedDocuments(options: GenerateOptions = {}): {
  documents: DocumentEntry[];
  submissions: Submission[];
  patients: string[];
} {
  const documents: DocumentEntry[] = [];
  const submissions: Submission[] = [];
  const people = syntheticPeople(options);
  for (const [i, person] of people.entries()) {
    const n = i + 1;
    const patientId = patientCx(person.mrn);
    const set: Submission = {
      entryUUID: `urn:uuid:00000000-0000-4000-8000-${String(n).padStart(8, "0")}0000`,
      uniqueId: `${SOURCE_ID}.${n}`,
      sourceId: SOURCE_ID,
      patientId,
      submissionTime: "20260105120000",
      documents: [],
    };
    for (const [k, kind] of KINDS.entries()) {
      const content = Buffer.from(
        `${kind.display} (synthetic)\nPatient: ${person.given} ${person.family}, born ${person.birthDate}\n` +
          `Fictional clinic visit for testing document sharing. Not a real record.\n`,
      );
      const entryUUID = `urn:uuid:00000000-0000-4000-8000-${String(n).padStart(8, "0")}000${k + 1}`;
      documents.push({
        entryUUID,
        uniqueId: `${SOURCE_ID}.${n}.${k + 1}`,
        patientId,
        status: STATUS_APPROVED,
        mimeType: "text/plain",
        title: `${kind.title} for ${person.given} ${person.family}`,
        creationTime: `2026010${k + 1}100000`,
        languageCode: "en-US",
        codes: {
          ...COMMON_CODES,
          classCode: { code: kind.code, scheme: LOINC, display: kind.display },
          typeCode: { code: kind.code, scheme: LOINC, display: kind.display },
        },
        repositoryUniqueId: REPOSITORY_ID,
        size: content.length,
        hash: sha1(content),
        submissionSet: set.entryUUID,
        content,
      });
      set.documents.push(entryUUID);
    }
    submissions.push(set);
  }
  return { documents, submissions, patients: people.map((p) => patientCx(p.mrn)) };
}
