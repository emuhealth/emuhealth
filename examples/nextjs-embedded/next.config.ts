import { resolve } from "path";
import type { NextConfig } from "next";
import { withEmuhealth } from "@emulators/adapter-next";

const nextConfig: NextConfig = {
  turbopack: {
    root: resolve(import.meta.dirname, "../.."),
  },
};

export default withEmuhealth(nextConfig);
