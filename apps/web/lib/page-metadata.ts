import type { Metadata } from "next";
import { PAGE_TITLES } from "./page-titles";

const DESCRIPTION =
  "Local drop-in replacement services for CI and no-network sandboxes. Fully stateful, production-fidelity API emulation.";

export function pageMetadata(slug: string): Metadata {
  const title = PAGE_TITLES[slug];
  if (!title) return {};

  const displayTitle = title.replace(/\n/g, " ");
  const fullTitle = `${displayTitle} | EmuHealth`;
  const ogImageUrl = slug ? `/og/${slug}` : "/og";

  return {
    title: displayTitle,
    description: DESCRIPTION,
    openGraph: {
      type: "website",
      locale: "en_US",
      siteName: "EmuHealth",
      title: fullTitle,
      description: DESCRIPTION,
      images: [
        {
          url: ogImageUrl,
          width: 1200,
          height: 630,
          alt: `${displayTitle} - EmuHealth`,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: fullTitle,
      description: DESCRIPTION,
      images: [ogImageUrl],
    },
  };
}
