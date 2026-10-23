import { defineConfig } from "drizzle-kit"
import { existsSync } from "node:fs"

// Generar SQL es offline: no lee archivos privados ni exige credenciales.
// La aplicación legacy conserva su carga actual hasta el despachador U-INF-04.
const generating = process.argv.includes("generate")
if (!generating) {
  for (const file of [".env.local", ".env"]) {
    if (existsSync(file)) process.loadEnvFile(file)
  }
}

export default defineConfig({
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  ...(!generating && { dbCredentials: {
    url: process.env.SUPABASE_DB_URL ?? "",
  } }),
  strict: true,
  verbose: true,
  entities: {
    roles: {
      provider: "supabase",
    },
  },
})
