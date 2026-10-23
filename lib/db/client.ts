import "server-only"
import postgres from "postgres"
import { drizzle } from "drizzle-orm/postgres-js"
import { sql } from "drizzle-orm"
import * as schema from "@/lib/db/schema"

function createDb() {
  const dbUrl = process.env.SUPABASE_DB_URL
  if (!dbUrl) {
    throw new Error("No se ha configurado la conexión de la biblioteca.")
  }

  // 4 conexiones por proceso (U-FIX-02): con 1, las acciones concurrentes hacían cola en la única conexión
  // (experimento T4 en docs/validacion/rendimiento/2026-10-23-fix-02). Presupuesto: 4 por réplica de la app.
  const queryClient = postgres(dbUrl, {
    max: 4,
    prepare: false,
    ssl: ["localhost", "127.0.0.1", "[::1]"].includes(new URL(dbUrl).hostname) ? false : "require",
    idle_timeout: 20,
    connect_timeout: 10,
  })

  return drizzle(queryClient, { schema })
}

type Database = ReturnType<typeof createDb>
export type DatabaseTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0]
const shared = globalThis as typeof globalThis & { biblibDb?: Database }
function getDb(): Database {
  shared.biblibDb ??= createDb()
  return shared.biblibDb
}

export async function withRlsContext<T>(
  userId: string,
  callback: (tx: DatabaseTransaction) => Promise<T>,
): Promise<T> {
  const db = getDb()
  const claims = JSON.stringify({
    sub: userId,
    role: "authenticated",
  })

  const startedAt = Date.now()
  try { return await db.transaction(async (tx) => {
    // Claims y rol en una sola ida y vuelta; `set_config('role', …, true)` equivale a `set local role`.
    await tx.execute(sql`select set_config('request.jwt.claims', ${claims}, true), set_config('request.jwt.claim.sub', ${userId}, true), set_config('role', 'authenticated', true)`)
    return callback(tx)
  }) } catch (error) {
    console.error(JSON.stringify({ event: "database.operation_failed", durationMs: Date.now() - startedAt }))
    throw error
  }
}
