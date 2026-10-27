import { SYNTHETIC_TAG, type FhirResource } from "@emuhealth/fhir-core";
import { PAYER_ID } from "./carin.js";

// A synthetic provider directory shaped by the Da Vinci PDex Plan-Net IG: networks, provider organizations,
// locations, practitioners and their roles, healthcare services, insurance plans, an endpoint, and organization
// affiliations. Specialties are text only: emuhealth does not bundle the NUCC provider taxonomy.

const PLAN_NET = "http://hl7.org/fhir/us/davinci-pdex-plan-net";
const SD = `${PLAN_NET}/StructureDefinition`;
const CS = `${PLAN_NET}/CodeSystem`;
const NPI = "http://hl7.org/fhir/sid/us-npi";

const meta = (profile: string) => ({ profile: [`${SD}/${profile}`], tag: [SYNTHETIC_TAG] });

/** Synthetic NPIs: Luhn-valid over the 80840 prefix with a leading 0, so never a real NPI. */
export function syntheticNpi(serial: number): string {
  const body = `0${String(serial).padStart(8, "0")}`;
  const digits = `80840${body}`.split("").map(Number);
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits[digits.length - 1 - i];
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return `${body}${(10 - (sum % 10)) % 10}`;
}

const FAMILY = ["Example", "Sample", "Placeholder", "Fictional", "Demo", "Mock", "Testcase", "Stub"];
const GIVEN = [
  "Alex",
  "Blair",
  "Casey",
  "Drew",
  "Emery",
  "Finley",
  "Harper",
  "Jordan",
  "Kendall",
  "Logan",
  "Morgan",
  "Quinn",
];
const SPECIALTIES = [
  "Family medicine",
  "Internal medicine",
  "Pediatrics",
  "Cardiology",
  "Dermatology",
  "Endocrinology",
];
const CITIES = [
  { city: "Springfield", state: "IL", postalCode: "62701", lat: 39.78, lon: -89.65 },
  { city: "Madison", state: "WI", postalCode: "53703", lat: 43.07, lon: -89.38 },
  { city: "Columbus", state: "OH", postalCode: "43215", lat: 39.96, lon: -83.0 },
  { city: "Denver", state: "CO", postalCode: "80202", lat: 39.75, lon: -104.99 },
];

export function generateDirectory(): FhirResource[] {
  const out: FhirResource[] = [];
  const networks = [
    { id: "network-ppo", name: "Synthetic PPO Network" },
    { id: "network-hmo", name: "Synthetic HMO Network" },
  ];
  for (const n of networks)
    out.push({
      resourceType: "Organization",
      id: n.id,
      meta: meta("plannet-Network"),
      active: true,
      type: [{ coding: [{ system: `${CS}/OrgTypeCS`, code: "ntwk", display: "Network" }] }],
      name: n.name,
      partOf: { reference: `Organization/${PAYER_ID}` },
      contact: [{ telecom: [{ system: "phone", value: "555-0191", use: "work" }] }],
    });
  out.push({
    resourceType: "Organization",
    id: PAYER_ID,
    meta: meta("plannet-Organization"),
    active: true,
    type: [{ coding: [{ system: `${CS}/OrgTypeCS`, code: "payer", display: "Payer" }] }],
    name: "Synthetic Health Plan",
    telecom: [{ system: "phone", value: "555-0190", use: "work" }],
    address: [{ line: ["1 Example Plaza"], city: "Springfield", state: "IL", postalCode: "62701", country: "US" }],
  });

  const groups = Array.from({ length: 6 }, (_, i) => ({
    id: `provider-org-${i + 1}`,
    city: CITIES[i % CITIES.length],
  }));
  for (const [i, g] of groups.entries())
    out.push({
      resourceType: "Organization",
      id: g.id,
      meta: meta("plannet-Organization"),
      identifier: [{ system: NPI, value: syntheticNpi(900 + i) }],
      active: true,
      type: [{ coding: [{ system: `${CS}/OrgTypeCS`, code: "prvgrp", display: "Provider Group" }] }],
      name: `Synthetic ${g.city.city} Medical Group`,
      telecom: [{ system: "phone", value: `555-02${String(i).padStart(2, "0")}`, use: "work" }],
      address: [
        {
          line: [`${100 + i * 10} Sample Ave`],
          city: g.city.city,
          state: g.city.state,
          postalCode: g.city.postalCode,
          country: "US",
        },
      ],
    });

  const locations = groups.map((g, i) => ({ id: `location-${i + 1}`, org: g.id, city: g.city }));
  for (const [i, l] of locations.entries())
    out.push({
      resourceType: "Location",
      id: l.id,
      meta: meta("plannet-Location"),
      status: "active",
      name: `Synthetic ${l.city.city} Clinic`,
      telecom: [{ system: "phone", value: `555-03${String(i).padStart(2, "0")}`, use: "work" }],
      address: {
        line: [`${100 + i * 10} Sample Ave`],
        city: l.city.city,
        state: l.city.state,
        postalCode: l.city.postalCode,
        country: "US",
      },
      position: { latitude: l.city.lat + i * 0.01, longitude: l.city.lon - i * 0.01 },
      managingOrganization: { reference: `Organization/${l.org}` },
      hoursOfOperation: [
        { daysOfWeek: ["mon", "tue", "wed", "thu", "fri"], openingTime: "08:00:00", closingTime: "17:00:00" },
      ],
    });
  // The plans' coverage area.
  out.push({
    resourceType: "Location",
    id: "coverage-area",
    meta: meta("plannet-Location"),
    status: "active",
    name: "Synthetic Health Plan service area",
    address: { state: "IL", country: "US" },
  });

  for (let p = 0; p < 24; p++) {
    const id = `practitioner-${p + 1}`;
    const location = locations[p % locations.length];
    const network = networks[p % 3 === 0 ? 1 : 0];
    out.push({
      resourceType: "Practitioner",
      id,
      meta: meta("plannet-Practitioner"),
      identifier: [{ system: NPI, value: syntheticNpi(1000 + p) }],
      active: true,
      name: [{ family: FAMILY[p % FAMILY.length], given: [GIVEN[p % GIVEN.length]], prefix: ["Dr."] }],
      gender: p % 2 === 0 ? "female" : "male",
      qualification: [{ code: { text: "Doctor of Medicine" }, issuer: { display: "Synthetic Medical Board" } }],
    });
    out.push({
      resourceType: "PractitionerRole",
      id: `practitionerrole-${p + 1}`,
      meta: meta("plannet-PractitionerRole"),
      extension: [
        { url: `${SD}/network-reference`, valueReference: { reference: `Organization/${network.id}` } },
        {
          url: `${SD}/newpatients`,
          extension: [
            {
              url: "acceptingPatients",
              valueCodeableConcept: {
                coding: [{ system: `${CS}/AcceptingPatientsCS`, code: p % 4 === 3 ? "nopt" : "newpt" }],
              },
            },
          ],
        },
      ],
      active: true,
      practitioner: { reference: `Practitioner/${id}` },
      organization: { reference: `Organization/${location.org}` },
      code: [{ coding: [{ system: `${CS}/ProviderRoleCS`, code: "ph", display: "Physician" }] }],
      specialty: [{ text: SPECIALTIES[p % SPECIALTIES.length] }],
      location: [{ reference: `Location/${location.id}` }],
      telecom: [{ system: "phone", value: `555-04${String(p).padStart(2, "0")}`, use: "work" }],
    });
  }

  for (const [i, l] of locations.slice(0, 4).entries())
    out.push({
      resourceType: "HealthcareService",
      id: `service-${i + 1}`,
      meta: meta("plannet-HealthcareService"),
      active: true,
      providedBy: { reference: `Organization/${l.org}` },
      category: [
        { coding: [{ system: `${CS}/HealthcareServiceCategoryCS`, code: "prov", display: "Medical Provider" }] },
      ],
      type: [{ text: i % 2 ? "Laboratory services" : "Primary care" }],
      name: `${i % 2 ? "Laboratory" : "Primary care"} at Synthetic ${l.city.city} Clinic`,
      location: [{ reference: `Location/${l.id}` }],
      telecom: [{ system: "phone", value: `555-05${String(i).padStart(2, "0")}`, use: "work" }],
    });

  const plans = [
    { id: "plan-ppo-gold", name: "Synthetic PPO Gold", product: "commppo", tier: "gold", network: "network-ppo" },
    { id: "plan-hmo-silver", name: "Synthetic HMO Silver", product: "commhmo", tier: "silver", network: "network-hmo" },
  ];
  for (const plan of plans)
    out.push({
      resourceType: "InsurancePlan",
      id: plan.id,
      meta: meta("plannet-InsurancePlan"),
      status: "active",
      type: [{ coding: [{ system: `${CS}/InsuranceProductTypeCS`, code: plan.product }] }],
      name: plan.name,
      ownedBy: { reference: `Organization/${PAYER_ID}` },
      administeredBy: { reference: `Organization/${PAYER_ID}` },
      coverageArea: [{ reference: "Location/coverage-area" }],
      network: [{ reference: `Organization/${plan.network}` }],
      plan: [{ type: { coding: [{ system: `${CS}/InsurancePlanTypeCS`, code: plan.tier }] } }],
    });

  out.push({
    resourceType: "Endpoint",
    id: "endpoint-patient-access",
    meta: meta("plannet-Endpoint"),
    status: "active",
    connectionType: { system: "http://terminology.hl7.org/CodeSystem/endpoint-connection-type", code: "hl7-fhir-rest" },
    name: "Synthetic Health Plan patient access API",
    managingOrganization: { reference: `Organization/${PAYER_ID}` },
    payloadType: [{ coding: [{ system: `${CS}/EndpointPayloadTypeCS`, code: "NA" }] }],
    address: "http://localhost:4128/fhir",
  });

  for (const g of groups)
    out.push({
      resourceType: "OrganizationAffiliation",
      id: `affiliation-${g.id}`,
      meta: meta("plannet-OrganizationAffiliation"),
      active: true,
      organization: { reference: `Organization/${PAYER_ID}` },
      participatingOrganization: { reference: `Organization/${g.id}` },
      network: [{ reference: "Organization/network-ppo" }],
      code: [{ coding: [{ system: `${CS}/OrganizationAffiliationRoleCS`, code: "outpatient" }] }],
      location: [{ reference: `Location/location-${groups.indexOf(g) + 1}` }],
    });
  return out;
}
