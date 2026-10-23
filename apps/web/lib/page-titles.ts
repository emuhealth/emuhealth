export const PAGE_TITLES: Record<string, string> = {
  "": "Local API Emulation\nfor Health Apps",
  "programmatic-api": "Programmatic API",
  "custom-emulators": "Custom Emulators",
  configuration: "Configuration",
  fhir: "FHIR R4",
  nppes: "NPPES NPI Registry",
  ncbi: "NCBI E-utilities",
  clinicaltrials: "ClinicalTrials.gov",
  rxnav: "RxNav",
  epic: "Epic",
  openfda: "openFDA",
  nextjs: "Next.js Integration",
  nuxt: "Nuxt Integration",
  vercel: "Vercel API",
  github: "GitHub API",
  google: "Google API",
  slack: "Slack API",
  linear: "Linear API",
  twilio: "Twilio API",
  apple: "Apple Sign In",
  microsoft: "Microsoft Entra ID",
  aws: "AWS",
  okta: "Okta",
  mongoatlas: "MongoDB Atlas",
  resend: "Resend",
  stripe: "Stripe",
  authentication: "Authentication",
  architecture: "Architecture",
};

export function getPageTitle(slug: string): string | null {
  return slug in PAGE_TITLES ? PAGE_TITLES[slug]! : null;
}
