import { defineConfig } from "drizzle-kit"

// Drizzle Kit solo se usa offline (generate/check): no lee .env/.env.local ni abre conexiones.
// El único aplicador del esquema es el runner de U-INF-04 (db:status/plan/migrate:local), que
// fija el mismo ledger que se declara aquí.
const offline = ["generate", "check", "up"]
const command = process.argv.slice(2).find((arg) => !arg.startsWith("-"))
if (command && !offline.includes(command)) {
  throw new Error(`drizzle-kit ${command} no está habilitado en BibLib: usa pnpm db:status:local, db:plan:local y db:migrate:local.`)
}

export default defineConfig({
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  migrations: {
    schema: "biblib_migrations",
    table: "__drizzle_migrations",
  },
  strict: true,
  verbose: true,
  entities: {
    roles: {
      provider: "supabase",
    },
  },
})
