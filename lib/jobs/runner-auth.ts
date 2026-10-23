import { createHmac, timingSafeEqual } from "node:crypto"

// Token de la entrada interna del ejecutor (U-DAT-03). Con `BIBLIB_JOBS_RUNNER_SECRET` (al menos 32
// caracteres) se usa ese secreto; sin él se deriva de `SUPABASE_DB_URL`, que ya concede acceso total
// a la base, así que no amplía la superficie. `scripts/jobs/run-local.mjs` aplica la misma derivación.

export const RUNNER_TOKEN_LABEL = "biblib.jobs.runner.v1"

export function runnerToken(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  const explicit = env.BIBLIB_JOBS_RUNNER_SECRET
  if (explicit) return explicit.length >= 32 ? explicit : null
  return env.SUPABASE_DB_URL ? createHmac("sha256", env.SUPABASE_DB_URL).update(RUNNER_TOKEN_LABEL).digest("base64url") : null
}

/** Compara en tiempo constante la cabecera `Authorization: Bearer …` con el token del ejecutor. */
export function isRunnerAuthorized(header: string | null, env?: Readonly<Record<string, string | undefined>>): boolean {
  const expected = runnerToken(env)
  const match = header ? /^Bearer ([A-Za-z0-9_\-.~+/=]{32,256})$/.exec(header) : null
  if (!expected || !match) return false
  const given = Buffer.from(match[1])
  const wanted = Buffer.from(expected)
  return given.length === wanted.length && timingSafeEqual(given, wanted)
}
