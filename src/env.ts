import { panic } from "better-result";
import { z } from "zod";

const EnvSchema = z.object({
  TURSO_DATABASE_URL: z.string().min(1),
  TURSO_AUTH_TOKEN: z.string().min(1).optional(),
  REDIS_URL: z.string().min(1),
  PHACK_API_KEY: z.string().min(1),
});

// A blank line in a .env file yields an empty string. Treat those keys as
// unset so optional variables stay optional and required ones report as
// missing instead of "too small".
const definedEnv = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => value !== undefined && value !== ""),
);

const validation = EnvSchema.safeParse(definedEnv);

if (!validation.success) {
  panic(`Invalid environment: ${z.prettifyError(validation.error)}`);
}

/**
 * Validated process environment. Module load panics when a required
 * variable is missing, so imports can rely on every key.
 */
export const env: z.output<typeof EnvSchema> = validation.data;
