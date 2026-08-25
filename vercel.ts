import type { VercelConfig } from "@vercel/config/v1";

export const config: VercelConfig = {
  bunVersion: "1.4.x",
  functions: {
    "src/server.ts": {
      maxDuration: "max",
    },
  },
};
