export const siteName = "emuhealth";
export const siteUrl = "https://www.emuhealth.dev";
export const siteDescription =
  "Local, stateful API emulators for healthcare and life science development, plus every emulate service. Synthetic data only.";
export const isPreview = Boolean(process.env.VERCEL_ENV && process.env.VERCEL_ENV !== "production");

export function canonicalUrlFor(pathname: string): string {
  return pathname === "/" ? siteUrl : `${siteUrl}${pathname}`;
}
