export type NavItem = {
  name: string;
  href: string;
  label?: string;
};

type NavSection = {
  title?: string;
  items: NavItem[];
};

export const docsSections: NavSection[] = [
  {
    items: [
      { name: "Getting Started", href: "/docs" },
      { name: "Custom Emulators", href: "/docs/custom-emulators" },
      { name: "Programmatic API", href: "/docs/programmatic-api" },
      { name: "Configuration", href: "/docs/configuration" },
      { name: "Next.js Integration", href: "/docs/nextjs" },
      { name: "Nuxt Integration", href: "/docs/nuxt" },
    ],
  },
  {
    title: "Health",
    items: [
      { name: "FHIR R4", href: "/docs/fhir" },
      { name: "Epic", href: "/docs/epic" },
      { name: "openFDA", href: "/docs/openfda" },
      { name: "RxNav", href: "/docs/rxnav" },
      { name: "ClinicalTrials.gov", href: "/docs/clinicaltrials" },
      { name: "NCBI E-utilities", href: "/docs/ncbi" },
      { name: "NPPES NPI Registry", href: "/docs/nppes" },
      { name: "Benchling", href: "/docs/benchling" },
      { name: "REDCap", href: "/docs/redcap" },
      { name: "Oracle Health (Cerner)", href: "/docs/cerner" },
      { name: "athenahealth", href: "/docs/athena" },
      { name: "CMS Blue Button 2.0", href: "/docs/bluebutton" },
      { name: "CDS Hooks", href: "/docs/cdshooks" },
      { name: "Redox", href: "/docs/redox" },
      { name: "AWS HealthLake", href: "/docs/healthlake" },
      { name: "Google Cloud Healthcare API", href: "/docs/gcphealthcare" },
      { name: "Azure Health Data Services", href: "/docs/azurehealth" },
      { name: "Stedi", href: "/docs/stedi" },
      { name: "Availity", href: "/docs/availity" },
      { name: "Dexcom", href: "/docs/dexcom" },
      { name: "Fitbit", href: "/docs/fitbit" },
      { name: "Oura", href: "/docs/oura" },
      { name: "Withings", href: "/docs/withings" },
    ],
  },
  {
    title: "Services",
    items: [
      { name: "Vercel API", label: "Vercel", href: "/docs/vercel" },
      { name: "GitHub API", label: "GitHub", href: "/docs/github" },
      { name: "Google API", label: "Google", href: "/docs/google" },
      { name: "Slack API", label: "Slack", href: "/docs/slack" },
      { name: "Linear API", label: "Linear", href: "/docs/linear" },
      { name: "Twilio API", label: "Twilio", href: "/docs/twilio" },
      { name: "Apple Sign In", label: "Apple", href: "/docs/apple" },
      { name: "Microsoft Entra ID", href: "/docs/microsoft" },
      { name: "AWS", href: "/docs/aws" },
      { name: "Okta", href: "/docs/okta" },
      { name: "MongoDB Atlas", href: "/docs/mongoatlas" },
      { name: "Resend", href: "/docs/resend" },
      { name: "Stripe", href: "/docs/stripe" },
    ],
  },
  {
    title: "Reference",
    items: [
      { name: "Authentication", href: "/docs/authentication" },
      { name: "Architecture", href: "/docs/architecture" },
    ],
  },
];

export const allDocsPages: NavItem[] = docsSections.flatMap((section) => section.items);
