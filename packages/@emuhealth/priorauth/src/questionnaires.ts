import { SYNTHETIC_TAG, type FhirResource } from "@emuhealth/fhir-core";

// DTR questionnaires for the rules that need documentation. They use SDC initialExpression in FHIRPath to prefill
// from the patient's record; DTR's CQL libraries are not emulated.

const SDC = "http://hl7.org/fhir/uv/sdc/StructureDefinition";

const prefill = (expression: string) => [
  { url: `${SDC}/sdc-questionnaire-initialExpression`, valueExpression: { language: "text/fhirpath", expression } },
];

function questionnaire(id: string, title: string, items: unknown[], base: string): FhirResource {
  return {
    resourceType: "Questionnaire",
    id,
    meta: {
      profile: ["http://hl7.org/fhir/us/davinci-dtr/StructureDefinition/dtr-std-questionnaire"],
      tag: [SYNTHETIC_TAG],
    },
    url: `${base}/Questionnaire/${id}`,
    version: "1.0.0",
    name: id.replace(/-/g, "_"),
    title,
    status: "active",
    subjectType: ["Patient"],
    item: items,
  };
}

const patientItems = [
  {
    linkId: "patient-name",
    text: "Patient name",
    type: "string",
    required: true,
    extension: prefill("%patient.name.first().family"),
  },
  {
    linkId: "patient-birthdate",
    text: "Date of birth",
    type: "date",
    required: true,
    extension: prefill("%patient.birthDate"),
  },
];

export function questionnaires(base: string): FhirResource[] {
  return [
    questionnaire(
      "home-cpap",
      "Home CPAP documentation",
      [
        ...patientItems,
        { linkId: "sleep-study-date", text: "Date of the diagnostic sleep study", type: "date", required: true },
        { linkId: "ahi", text: "Apnea-hypopnea index (events per hour)", type: "decimal", required: true },
        {
          linkId: "adherence-plan",
          text: "Is an adherence follow-up planned within 90 days?",
          type: "boolean",
          required: true,
        },
      ],
      base,
    ),
    questionnaire(
      "home-oxygen",
      "Home oxygen documentation",
      [
        ...patientItems,
        {
          linkId: "spo2",
          text: "Oxygen saturation at rest (%)",
          type: "decimal",
          required: true,
        },
        { linkId: "flow-rate", text: "Prescribed flow rate (L/min)", type: "decimal", required: true },
      ],
      base,
    ),
    questionnaire(
      "hospital-bed",
      "Hospital bed documentation",
      [
        ...patientItems,
        {
          linkId: "positioning",
          text: "Does the patient need positioning not possible in an ordinary bed?",
          type: "boolean",
          required: true,
        },
      ],
      base,
    ),
  ];
}
