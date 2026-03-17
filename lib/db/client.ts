import postgres from "postgres"
import { drizzle } from "drizzle-orm/postgres-js"
import { sql } from "drizzle-orm"
import * as schema from "@/lib/db/schema"

function getDb() {
  const dbUrl = process.env.SUPABASE_DB_URL
  if (!dbUrl) {
    throw new Error("Missing SUPABASE_DB_URL environment variable")
  }

  const queryClient = postgres(dbUrl, {
    max: 1,
    prepare: false,
  })

  return drizzle(queryClient, { schema })
}

export async function withRlsContext<T>(
  userId: string,
  callback: (tx: ReturnType<typeof getDb>) => Promise<T>,
): Promise<T> {
  const db = getDb()
  const claims = JSON.stringify({
    sub: userId,
    role: "authenticated",
  })

  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('request.jwt.claims', ${claims}, true)`)
    await tx.execute(sql`select set_config('request.jwt.claim.sub', ${userId}, true)`)
    await tx.execute(sql`set local role authenticated`)
    return callback(tx as ReturnType<typeof getDb>)
  })
}
