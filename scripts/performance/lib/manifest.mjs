import { execFile } from "node:child_process"
import { readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { REPO_ROOT } from "../../lib/profiles.mjs"

const run = promisify(execFile)
const GIB = 1024 ** 3

async function command(file, args) {
  try {
    const { stdout } = await run(file, args, { cwd: REPO_ROOT, windowsHide: true, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 })
    return stdout.trim()
  } catch { return null }
}

function packageVersion(name) {
  try { return JSON.parse(readFileSync(path.join(REPO_ROOT, "node_modules", name, "package.json"), "utf8")).version } catch { return null }
}

function packageManager() {
  try { return JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")).packageManager?.replace(/^pnpm@/, "") ?? null } catch { return null }
}

/**
 * Manifiesto de la medición: hardware del anfitrión, recursos asignados a Docker y versiones. No incluye
 * nombre de equipo, direcciones, usuario del sistema ni variables de entorno.
 */
export async function collectManifest({ sql, projectId, browserVersion = null }) {
  const info = await command("docker", ["info", "--format", "{{json .}}"])
  const docker = info ? JSON.parse(info) : {}
  const clientVersion = await command("docker", ["version", "--format", "{{.Client.Version}}"])
  const running = (await command("docker", ["ps", "--format", "{{.Names}}"]))?.split(/\r?\n/).filter(Boolean) ?? []
  const own = running.filter((name) => name.endsWith(`_${projectId}`))
  const images = Object.fromEntries((await Promise.all(own.map(async (name) => [name.replace(/_[^_]+$/, "").replace(/^supabase_/, ""), await command("docker", ["inspect", "--format", "{{.Config.Image}}", name])]))).sort())
  const settings = Object.fromEntries((await sql.unsafe(`/* perf */ select name, setting, unit from pg_settings where name in ('shared_buffers','effective_cache_size','work_mem','maintenance_work_mem','max_connections','jit','random_page_cost','max_parallel_workers_per_gather','default_statistics_target','synchronous_commit','fsync')`)).map((row) => [row.name, `${row.setting}${row.unit ?? ""}`]))
  const [{ version }] = await sql.unsafe("/* perf */ select version()")
  const cpus = os.cpus()
  return {
    generadoEn: new Date().toISOString(),
    commit: await command("git", ["rev-parse", "HEAD"]),
    rama: await command("git", ["branch", "--show-current"]),
    anfitrion: {
      sistema: `${os.type()} ${os.release()} (${os.arch()})`,
      cpu: cpus[0]?.model?.trim() ?? null,
      nucleosLogicos: cpus.length,
      ramTotalGiB: Math.round((os.totalmem() / GIB) * 10) / 10,
      ramLibreAlInicioGiB: Math.round((os.freemem() / GIB) * 10) / 10,
    },
    docker: {
      cliente: clientVersion,
      servidor: docker.ServerVersion ?? null,
      sistemaOperativo: docker.OperatingSystem ?? null,
      nucleosAsignados: docker.NCPU ?? null,
      ramAsignadaGiB: docker.MemTotal ? Math.round((docker.MemTotal / GIB) * 10) / 10 : null,
      contenedoresEnMarchaTotales: running.length,
      contenedoresAjenosEnMarcha: running.length - own.length,
      imagenesDelPerfil: images,
    },
    postgres: { version: version.replace(/\s+on\s+.*$/, ""), ajustes: settings },
    software: {
      node: process.version, pnpm: packageManager(),
      next: packageVersion("next"), react: packageVersion("react"), drizzleOrm: packageVersion("drizzle-orm"),
      postgresJs: packageVersion("postgres"), supabaseCli: packageVersion("supabase"), playwright: packageVersion("@playwright/test"),
      navegador: browserVersion,
    },
  }
}
