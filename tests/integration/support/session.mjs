import { createServerClient } from "@supabase/ssr"
import { BiblibError, EXIT } from "../../../scripts/lib/exit-codes.mjs"
import { REPO_ROOT } from "../../../scripts/lib/profiles.mjs"
import { loadCensus, resolveSeedTarget } from "../../../scripts/db/seed-local.mjs"
import { readFixtureStore } from "../../../scripts/db/fixture-store.mjs"

/** GoTrue real y cookies fragmentadas/base64url gestionadas por @supabase/ssr como en la app. */
export async function signInFixture(as, { profile = process.env.BIBLIB_PROFILE || "main", root = REPO_ROOT } = {}) {
  if (!["a", "b"].includes(as) || (process.env.BIBLIB_TARGET && process.env.BIBLIB_TARGET !== "local")) throw new BiblibError(EXIT.IDENTITY_MISMATCH, "sesión", "El harness solo admite las cuentas A/B del perfil local.")
  const resolved = await resolveSeedTarget(profile, { root })
  const store = readFixtureStore(resolved, loadCensus(root))
  const account = store?.accounts[as]
  if (!account?.id) throw new BiblibError(EXIT.SEED_FAILED, "sesión", "Faltan fixtures registrados; ejecuta db:seed:local para este perfil.")
  const values = resolved.target.env()
  const jar = new Map()
  const client = createServerClient(values.SUPABASE_URL, values.SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false },
    cookies: {
      getAll: () => [...jar.values()].map(({ name, value }) => ({ name, value })),
      setAll: (items) => { for (const item of items) jar.set(item.name, item) },
    },
  })
  const { data, error } = await client.auth.signInWithPassword({ email: account.email, password: account.password })
  if (error || !data.session || data.user?.id !== account.id) throw new BiblibError(EXIT.VERIFICATION_FAILED, "sesión", "GoTrue no validó la sesión del fixture registrado.")
  return { client, session: data.session, user: data.user, cookies: () => [...jar.values()], resolved }
}
