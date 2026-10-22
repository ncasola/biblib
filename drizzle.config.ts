import { defineConfig } from "drizzle-kit"
import { existsSync } from "node:fs"

// La CLI de Drizzle no carga los archivos de entorno de Next por sí sola.
for (const file of [".env.local", ".env"]) {
  if (existsSync(file)) process.loadEnvFile(file)
}

export default defineConfig({
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.SUPABASE_DB_URL ?? "",
  },
  strict: true,
  verbose: true,
  entities: {
    roles: {
      provider: "supabase",
    },
  },
})
