import { createApp } from "./app.mjs"
import { adminClient, closeConnection, database, integrationContext, PROFILE, runId } from "./context.mjs"
import { cleanupManifest, forgetCreated, manifestFile, recordCreated } from "./run-manifest.mjs"
import { signOutAll } from "./sessions.mjs"

/** Preparación común de cada archivo de la suite: contexto acreditado, app, SQL y manifiesto. */
export async function setupSuite() {
  runId()
  const ctx = await integrationContext()
  const sql = database(ctx)
  const manifest = manifestFile(PROFILE, ctx.root)
  const own = {}
  const forget = (kind, entry) => {
    forgetCreated(manifest, kind, entry)
    own[kind] = (own[kind] ?? []).filter((item) => Object.keys(entry).some((key) => item[key] !== entry[key]))
  }
  return {
    ctx, sql,
    app: createApp(ctx),
    admin: () => adminClient(ctx),
    record: (kind, entry) => { recordCreated(manifest, kind, entry); (own[kind] ??= []).push(entry) },
    forget,
    /** Limpia al terminar el archivo lo que registró esta suite; lo que no pueda queda para el final del run. */
    async cleanupOwn() {
      const pending = await cleanupManifest({ sql, admin: adminClient(ctx), manifest: { runId: runId(), created: { books: [], shelves: [], objects: [], metadata: [], ...own } } })
      for (const [kind, entries] of Object.entries(own)) for (const entry of [...entries]) if (!(pending[kind] ?? []).some((item) => Object.keys(entry).every((key) => item[key] === entry[key]))) forget(kind, entry)
    },
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
