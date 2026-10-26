import { writeSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { createClient } from "@supabase/supabase-js"
import postgres from "postgres"
import { REPO_ROOT } from "../../../../scripts/lib/profiles.mjs"

// Proceso trabajador independiente del grupo assets (U-DAT-10): el ejecutor compilado con la sesión
// Storage del dueño (su JWT) y una imagen ficticia en lugar de red. El punto `afterUpload: "kill"`
// termina el proceso de golpe (137) después de subir el objeto y antes de registrarlo.

const require = createRequire(import.meta.url)
const build = path.join(REPO_ROOT, ".next", "tests", "lib")
const { createJobDatabase, createJobRepository } = require(path.join(build, "jobs", "repository.js"))
const { drainJobs } = require(path.join(build, "jobs", "worker.js"))
const { createSupabaseAssetStorage } = require(path.join(build, "assets", "repository.js"))
const { fixtureCoverBytes } = require(path.join(build, "assets", "image-validation.js"))
const { providerRightsPolicy } = require(path.join(build, "bibliographic-catalog", "rights.js"))

const task = JSON.parse(process.argv[2])
const sql = postgres(process.env.BIBLIB_ASSETS_TEST_DB_URL, { max: 2, prepare: false, ssl: false, connect_timeout: 5, idle_timeout: 5, onnotice: () => {}, connection: { application_name: "biblib-assets-child" } })
const client = createClient(process.env.BIBLIB_ASSETS_TEST_SUPABASE_URL, process.env.BIBLIB_ASSETS_TEST_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: { headers: { Authorization: `Bearer ${process.env.BIBLIB_ASSETS_TEST_TOKEN}` } },
})
const events = []
const print = (extra = {}) => writeSync(1, `${JSON.stringify({ events, ...extra })}\n`)

try {
  const assets = {
    storage: createSupabaseAssetStorage(client),
    rights: (provider) => ({ ...providerRightsPolicy(provider), ...(provider === "open-library" ? { rehostCover: true, backupAsset: true } : {}) }),
    fetchCover: async (key) => ({ bytes: await fixtureCoverBytes(`${key.ref}:${task.seed ?? ""}`), contentType: "image/jpeg" }),
    hooks: {
      afterUpload: async (job, key) => {
        events.push({ point: "afterUpload", fencing: job.fencing, key })
        if (task.afterUpload === "kill") { print({ killed: "afterUpload" }); process.exit(137) }
      },
    },
  }
  const reports = await drainJobs({ repo: createJobRepository(createJobDatabase(sql)), catalog: { getCover: async () => { throw new Error("sin catálogo") } }, random: () => 0, assets, limits: task.limits ?? {} }, { jobId: task.jobId, owner: task.owner }, 20_000)
  print({ reports })
} finally {
  await sql.end({ timeout: 2 }).catch(() => {})
}
