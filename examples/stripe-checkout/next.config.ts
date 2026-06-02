import { resolve } from "path";
import type { NextConfig } from "next";
import { withEmuhealth } from "@emulators/adapter-next";

const port = process.env.PORT ?? "3000";

const nextConfig: NextConfig = {
  turbopack: {
    root: resolve(import.meta.dirname, "../.."),
  },
  env: {
    STRIPE_HOST: "localhost",
    STRIPE_PORT: port,
    STRIPE_PROTOCOL: "http",
  },
  allowedDevOrigins: ["stripe-checkout.emuhealth.localhost"],
};

export default withEmuhealth(nextConfig);
