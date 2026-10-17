import "dotenv/config";

// Stripe Projects may name the key differently; accept the common spellings.
export const STRIPE_KEY =
  process.env.STRIPE_SECRET_KEY ?? process.env.STRIPE_API_KEY ?? process.env.STRIPE_KEY ?? "";

export const MODEL = process.env.CLAUDE_MODEL ?? "claude-opus-5-5";
export const EFFORT = (process.env.CLAUDE_EFFORT ?? "medium") as "low" | "medium" | "high";
export const PORT = Number(process.env.PORT ?? 3000);
export const PUBLIC_URL = process.env.PUBLIC_URL ?? `http://localhost:${PORT}`;
export const PRICE_CENTS = Number(process.env.AUDIT_PRICE_CENTS ?? 100);

export function requireEnv() {
  const missing: string[] = [];
  if (!process.env.ANTHROPIC_API_KEY) missing.push("ANTHROPIC_API_KEY");
  if (!process.env.CREATEOS_SANDBOX_API_KEY) missing.push("CREATEOS_SANDBOX_API_KEY");
  if (missing.length) {
    console.error(`Missing in .env: ${missing.join(", ")}`);
    process.exit(1);
  }
}
