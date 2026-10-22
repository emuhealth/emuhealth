import type { Metadata, Viewport } from "next";
import { Navbar } from "@vercel/geistdocs/navbar";
import { GeistMono } from "geist/font/mono";
import { GeistPixelSquare } from "geist/font/pixel";
import { GeistSans } from "geist/font/sans";
import { DocsProvider } from "@/components/geistdocs-provider";
import { config } from "@/lib/geistdocs/config";
import { isPreview, siteUrl } from "@/lib/site";
import "./globals.css";

const title = "emuhealth | Local API Emulation for Health Apps";
const description =
  "Local, stateful API emulators for healthcare and life science development. FHIR, SMART on FHIR, EHRs, payers, and life science APIs, without PHI. Synthetic data only.";

export const viewport: Viewport = { viewportFit: "cover" };

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: title,
    template: "%s | emuhealth",
  },
  description,
  alternates: { canonical: "/" },
  robots: { index: !isPreview, follow: !isPreview },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: siteUrl,
    siteName: "emuhealth",
    title,
    description,
    images: [{ url: "/og", width: 1200, height: 630, alt: "emuhealth" }],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: ["/og"],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const structuredData = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "emuhealth",
    url: siteUrl,
    description,
  };

  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${GeistSans.variable} ${GeistMono.variable} ${GeistPixelSquare.variable} antialiased`}
    >
      <head>
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }} />
      </head>
      <body>
        <DocsProvider>
          <Navbar config={config} />
          {children}
        </DocsProvider>
      </body>
    </html>
  );
}
