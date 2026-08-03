import "dotenv/config";
import LinqAPIV3 from "@linqapp/sdk";

export function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    throw new Error(
      `Missing ${name}. Copy .env.example → .env and fill it in (or export the var).`,
    );
  }
  return v;
}

/** Prefer LINQ_API_KEY; SDK also reads LINQ_API_V3_API_KEY. */
export function getApiKey(): string {
  return (
    process.env.LINQ_API_KEY?.trim() ||
    process.env.LINQ_API_V3_API_KEY?.trim() ||
    requireEnv("LINQ_API_KEY")
  );
}

export function createLinqClient(): LinqAPIV3 {
  return new LinqAPIV3({ apiKey: getApiKey() });
}

export function getFromNumber(): string {
  return requireEnv("LINQ_FROM_NUMBER");
}
