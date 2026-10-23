import { createApp } from "./app.mjs"
import { adminClient, closeConnection, database, integrationContext, PROFILE, runId } from "./context.mjs"
import { forgetCreated, manifestFile, recordCreated } from "./run-manifest.mjs"
import { signOutAll } from "./sessions.mjs"

/** Preparación común de cada archivo de la suite: contexto acreditado, app, SQL y manifiesto. */
export async function setupSuite() {
  runId()
  const ctx = await integrationContext()
  const sql = database(ctx)
  const manifest = manifestFile(PROFILE, ctx.root)
  return {
    ctx, sql,
    app: createApp(ctx),
    admin: () => adminClient(ctx),
    record: (kind, entry) => recordCreated(manifest, kind, entry),
    forget: (kind, entry) => forgetCreated(manifest, kind, entry),
    async close() {
      await signOutAll()
      await closeConnection(sql)
    },
  }
}

/** Los errores esperados de las acciones viajan como datos (`mutationResult`). */
export function expectFailure(result, code) {
  return result.status === 200 && result.value?.ok === false && result.value.error.code === code
}
