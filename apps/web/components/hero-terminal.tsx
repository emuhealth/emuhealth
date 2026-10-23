const services = [
  { name: "fhir", port: 4100, note: "FHIR R4" },
  { name: "epic", port: 4101, note: "Epic" },
  { name: "openfda", port: 4102, note: "openFDA" },
  { name: "rxnav", port: 4103, note: "RxNav" },
  { name: "clinicaltrials", port: 4104, note: "ClinicalTrials.gov" },
  { name: "ncbi", port: 4105, note: "NCBI E-utilities" },
  { name: "nppes", port: 4106, note: "NPPES NPI Registry" },
  { name: "benchling", port: 4107, note: "Benchling" },
  { name: "redcap", port: 4108, note: "REDCap" },
  { name: "cerner", port: 4109, note: "Oracle Health (Cerner)" },
  { name: "athena", port: 4110, note: "athenahealth" },
  { name: "bluebutton", port: 4111, note: "CMS Blue Button 2.0" },
  { name: "cdshooks", port: 4112, note: "CDS Hooks" },
  { name: "redox", port: 4113, note: "Redox" },
  { name: "healthlake", port: 4114, note: "AWS HealthLake" },
  { name: "gcphealthcare", port: 4115, note: "Google Cloud Healthcare API" },
  { name: "azurehealth", port: 4116, note: "Azure Health Data Services" },
  { name: "stedi", port: 4117, note: "Stedi" },
  { name: "availity", port: 4118, note: "Availity" },
  { name: "dexcom", port: 4119, note: "Dexcom" },
  { name: "fitbit", port: 4120, note: "Fitbit" },
  { name: "oura", port: 4121, note: "Oura" },
  { name: "withings", port: 4122, note: "Withings" },
  { name: "terra", port: 4123, note: "Terra" },
  { name: "dicomweb", port: 4124, note: "DICOMweb" },
  { name: "hl7v2", port: 4125, note: "HL7 v2 over MLLP" },
  { name: "veeva", port: 4126, note: "Veeva Vault" },
  { name: "rave", port: 4127, note: "Medidata Rave" },
];

export function HeroTerminal({ pixelFont }: { pixelFont: string }) {
  return (
    <div className="overflow-hidden rounded-xl border border-neutral-200 bg-neutral-950 shadow-lg dark:border-neutral-800">
      <div className="flex items-center border-b border-neutral-800 px-4 py-2.5">
        <div className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-neutral-700" />
          <span className="h-2.5 w-2.5 rounded-full bg-neutral-700" />
          <span className="h-2.5 w-2.5 rounded-full bg-neutral-700" />
        </div>
      </div>
      <pre className="overflow-x-auto p-5 text-[13px] leading-relaxed text-neutral-400 font-mono">
        <code>
          <span className="text-neutral-500">$</span> <span className="text-neutral-200">npx emuhealth</span>
          {"\n\n"}
          <span className={`${pixelFont} text-neutral-200`}>emuhealth</span>
          {" v0.8.0\n"}
          <span className="text-amber-400">
            Synthetic data only. Never load real patient data (PHI) into emuhealth.
          </span>
          {"\n\n"}
          {services.map((s) => (
            <span key={s.name}>
              {"  "}
              <span className="text-neutral-500">{s.name.padEnd(8)}</span>
              <span className="text-emerald-400">{`http://localhost:${s.port}`}</span>
              <span className="text-neutral-600">{`   # ${s.note}`}</span>
              {"\n"}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}
