// src/lib/config.ts
// Read one config value (secret or plain setting). Secrets reach the function
// as environment variables injected at deploy time; the documented form in
// TypeScript is process.env.NAME, but whether process.env exists in the
// umbrella runtime is UNVERIFIED, so try the env object first and fall back to
// globalThis.process?.env. Never throws. Never logs the value.
// An empty string counts as "not set".

export function readConfig(env: unknown, name: string): string | undefined {
  if (env !== null && typeof env === "object") {
    const value = (env as Record<string, unknown>)[name];
    if (typeof value === "string" && value !== "") {
      return value;
    }
  }
  // Typed defensively: do not assume process exists in this runtime.
  const procEnv = (globalThis as { process?: { env?: unknown } }).process?.env;
  if (procEnv !== null && typeof procEnv === "object") {
    const value = (procEnv as Record<string, unknown>)[name];
    if (typeof value === "string" && value !== "") {
      return value;
    }
  }
  return undefined;
}
