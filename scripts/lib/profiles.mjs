// Perfiles del stack Supabase local de BibLib (U-INF-01).
// Contrato: docs/spec-pendientes/orquestacion-f0.md §1. El manifiesto versionado es
// `supabase/profiles.json`; el workdir de cada perfil se genera en `.biblib/stacks/<perfil>/`
// a partir de `supabase/config.toml` (perfil base) cambiando solo identidad, puertos y app.

import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { BiblibError, EXIT } from "./exit-codes.mjs"

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
export const PROFILES_FILE = "supabase/profiles.json"
export const LOOPBACK = "127.0.0.1"
export const HOST_BINDING_OPTION = "com.docker.network.bridge.host_binding_ipv4"

/** Puertos que otros stacks locales (HolaERP y la plantilla por defecto del CLI) ya usan. */
export const FOREIGN_PORTS = Object.freeze([5432, ...Array.from({ length: 10 }, (_, index) => 54320 + index)])

/** Ubicación de cada puerto del perfil dentro de `config.toml`. */
export const CONFIG_PORT_KEYS = Object.freeze({
  shadow: { section: "db", key: "shadow_port" },
  api: { section: "api", key: "port" },
  db: { section: "db", key: "port" },
  studio: { section: "studio", key: "port" },
  mailpit: { section: "local_smtp", key: "port" },
  smtp: { section: "local_smtp", key: "smtp_port" },
  pop3: { section: "local_smtp", key: "pop3_port" },
  analytics: { section: "analytics", key: "port" },
  inspector: { section: "edge_runtime", key: "inspector_port" },
  pooler: { section: "db.pooler", key: "port" },
})

const PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{2,40}$/
const SECTION_PATTERN = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/
const ENTRY_PATTERN = /^(\s*)(#\s*)?([A-Za-z0-9_]+)(\s*=\s*)(.*)$/
const AUTH_URL_KEYS = new Set(["site_url", "additional_redirect_urls"])

function rootOf(options) {
  return options?.root ? path.resolve(options.root) : REPO_ROOT
}

function readText(filePath, phase) {
  try {
    return readFileSync(filePath, "utf8")
  } catch (error) {
    throw new BiblibError(EXIT.INVALID_ARGS, phase, `No se puede leer ${filePath}.`, { cause: error })
  }
}

function isPort(value) {
  return Number.isInteger(value) && value >= 1024 && value <= 65535
}

/**
 * Revisa el manifiesto de perfiles y devuelve la lista de problemas (vacía si es válido).
 * @param {unknown} manifest
 * @returns {string[]}
 */
export function validateProfiles(manifest) {
  const problems = []
  if (!manifest || typeof manifest !== "object") return ["El manifiesto de perfiles no es un objeto JSON."]
  const data = /** @type {Record<string, unknown>} */ (manifest)
  if (data.schemaVersion !== 1) problems.push("schemaVersion debe ser 1.")
  if (data.bindAddress !== LOOPBACK) problems.push(`bindAddress debe ser ${LOOPBACK}.`)
  if (typeof data.baseConfig !== "string" || typeof data.stateDir !== "string") problems.push("baseConfig y stateDir son obligatorios.")
  const services = /** @type {{ enabled?: unknown, disabled?: unknown } | undefined} */ (data.services)
  if (!Array.isArray(services?.enabled) || !Array.isArray(services?.disabled)) problems.push("services.enabled y services.disabled deben ser listas.")
  const portKeys = Array.isArray(data.portKeys) ? data.portKeys : []
  const expectedKeys = Object.keys(CONFIG_PORT_KEYS)
  if (portKeys.length !== expectedKeys.length || expectedKeys.some((key) => !portKeys.includes(key))) {
    problems.push(`portKeys debe contener exactamente: ${expectedKeys.join(", ")}.`)
  }
  const profiles = data.profiles && typeof data.profiles === "object" ? /** @type {Record<string, Record<string, unknown>>} */ (data.profiles) : {}
  if (Object.keys(profiles).length === 0) problems.push("No hay perfiles declarados.")
  if (typeof data.baseProfile !== "string" || !(data.baseProfile in profiles)) problems.push("baseProfile no corresponde a un perfil declarado.")

  /** @type {Map<number, string>} */
  const owners = new Map()
  const projectIds = new Set()
  for (const [name, profile] of Object.entries(profiles)) {
    const label = `Perfil ${name}`
    const projectId = profile?.projectId
    if (typeof projectId !== "string" || !PROJECT_ID_PATTERN.test(projectId)) {
      problems.push(`${label}: projectId no válido.`)
      continue
    }
    if (projectIds.has(projectId)) problems.push(`${label}: projectId ${projectId} repetido.`)
    projectIds.add(projectId)
    if (profile.network !== `${projectId}-network`) problems.push(`${label}: la red debe llamarse ${projectId}-network.`)
    const app = /** @type {{ host?: unknown, port?: unknown } | undefined} */ (profile.app)
    if (app?.host !== LOOPBACK) problems.push(`${label}: la aplicación debe escuchar en ${LOOPBACK}.`)
    const ports = /** @type {Record<string, unknown>} */ (profile.ports ?? {})
    const claimed = [["app", app?.port], ...expectedKeys.map((key) => [key, ports[key]])]
    for (const [key, port] of claimed) {
      if (!isPort(port)) {
        problems.push(`${label}: el puerto ${key} no es válido.`)
        continue
      }
      if (FOREIGN_PORTS.includes(port)) problems.push(`${label}: el puerto ${key} (${port}) pertenece a otro stack local.`)
      const owner = owners.get(port)
      if (owner) problems.push(`${label}: el puerto ${key} (${port}) ya lo usa ${owner}.`)
      owners.set(port, `${name}.${key}`)
    }
  }
  return problems
}

/**
 * Carga y valida `supabase/profiles.json`.
 * @param {{ root?: string }} [options]
 */
export function loadProfiles(options) {
  const root = rootOf(options)
  const filePath = path.join(root, PROFILES_FILE)
  let manifest
  try {
    manifest = JSON.parse(readText(filePath, "perfil"))
  } catch (error) {
    if (error instanceof BiblibError) throw error
    throw new BiblibError(EXIT.INVALID_ARGS, "perfil", `${PROFILES_FILE} no es JSON válido.`, { cause: error })
  }
  const problems = validateProfiles(manifest)
  if (problems.length > 0) {
    throw new BiblibError(EXIT.INVALID_ARGS, "perfil", `${PROFILES_FILE} no es válido:\n- ${problems.join("\n- ")}`)
  }
  return manifest
}

/**
 * Devuelve un perfil con los datos comunes del manifiesto ya resueltos.
 * @param {string} name
 * @param {{ root?: string }} [options]
 */
export function getProfile(name, options) {
  const manifest = loadProfiles(options)
  const profile = Object.hasOwn(manifest.profiles, name) ? manifest.profiles[name] : undefined
  if (!profile) {
    const known = Object.keys(manifest.profiles).join(", ")
    throw new BiblibError(EXIT.INVALID_ARGS, "perfil", `Perfil desconocido: «${name}». Perfiles disponibles: ${known}.`)
  }
  return {
    name,
    projectId: profile.projectId,
    network: profile.network,
    bindAddress: manifest.bindAddress,
    app: { ...profile.app },
    ports: { ...profile.ports },
    services: { enabled: [...manifest.services.enabled], disabled: [...manifest.services.disabled] },
    use: profile.use,
    isBase: name === manifest.baseProfile,
  }
}

/**
 * Directorio de trabajo del CLI para el perfil: `<raíz>/.biblib/stacks/<perfil>/`.
 * Es el valor que se pasa a `supabase --workdir`; el `config.toml` vive en su subcarpeta `supabase/`.
 * @param {string} name
 * @param {{ root?: string }} [options]
 */
export function profileWorkdir(name, options) {
  const manifest = loadProfiles(options)
  getProfile(name, options)
  return path.join(rootOf(options), manifest.stateDir, "stacks", name)
}

/**
 * Puertos del perfil, incluido el de la aplicación Next.js (`app`).
 * @param {string} name
 * @param {{ root?: string }} [options]
 */
export function profilePorts(name, options) {
  const profile = getProfile(name, options)
  return { ...profile.ports, app: profile.app.port }
}

/**
 * Raíz real del checkout y su huella. En Windows la ruta se normaliza sin distinguir mayúsculas.
 * @param {{ root?: string }} [options]
 */
export function rootFingerprint(options) {
  const real = realpathSync.native(rootOf(options))
  const normalized = process.platform === "win32" ? real.replaceAll("\\", "/").toLowerCase() : real
  const hash = createHash("sha256").update(normalized).digest("hex")
  return { root: real, hash, label: hash.slice(0, 16) }
}

/**
 * Especificación de la red Docker propia del perfil (nombre, opciones y etiquetas de propiedad).
 * @param {string} name
 * @param {{ root?: string }} [options]
 */
export function profileNetwork(name, options) {
  const profile = getProfile(name, options)
  return {
    name: profile.network,
    driverOptions: { [HOST_BINDING_OPTION]: profile.bindAddress },
    labels: { "biblib.profile": name, "biblib.root": rootFingerprint(options).label },
  }
}

/**
 * Entradas sin comentar de un `config.toml`, con clave `sección.clave` (o `clave` en la raíz).
 * Lector mínimo de las claves simples que usa BibLib; no es un parser TOML completo.
 * @param {string} toml
 * @returns {Map<string, string>}
 */
export function readConfigEntries(toml) {
  const entries = new Map()
  let section = ""
  for (const line of toml.split(/\r?\n/)) {
    const header = SECTION_PATTERN.exec(line)
    if (header) {
      section = header[1].trim()
      continue
    }
    const entry = ENTRY_PATTERN.exec(line)
    if (!entry || entry[2]) continue
    const value = entry[5].replace(/\s+#.*$/, "").trim()
    entries.set(section ? `${section}.${entry[3]}` : entry[3], value)
  }
  return entries
}

/**
 * Traduce el `config.toml` del perfil base al perfil indicado. Solo cambia `project_id`, los
 * puertos de `CONFIG_PORT_KEYS` (también en líneas comentadas de ejemplo) y el puerto de la
 * aplicación en las URL de Auth. Falla si el archivo base y el manifiesto no coinciden.
 * @param {string} baseToml
 * @param {{ projectId: string, ports: Record<string, number>, app: { port: number } }} base
 * @param {{ projectId: string, ports: Record<string, number>, app: { port: number } }} target
 */
export function renderProfileConfig(baseToml, base, target) {
  const eol = baseToml.includes("\r\n") ? "\r\n" : "\n"
  /** @type {Map<string, string>} */
  const portByLocation = new Map(Object.entries(CONFIG_PORT_KEYS).map(([name, location]) => [`${location.section}.${location.key}`, name]))
  const problems = []
  let section = ""
  let projectIdSeen = false
  const lines = baseToml.split(/\r?\n/).map((line) => {
    const header = SECTION_PATTERN.exec(line)
    if (header) {
      section = header[1].trim()
      return line
    }
    const entry = ENTRY_PATTERN.exec(line)
    if (!entry) return line
    const [, indent, comment = "", key, separator, rawValue] = entry
    if (!section && key === "project_id" && !comment) {
      projectIdSeen = true
      if (rawValue.trim() !== `"${base.projectId}"`) problems.push(`project_id de config.toml no es "${base.projectId}".`)
      return `${indent}${key}${separator}"${target.projectId}"`
    }
    const portName = portByLocation.get(`${section}.${key}`)
    if (portName) {
      const match = /^(\d+)(.*)$/.exec(rawValue)
      if (!match) return line
      if (Number(match[1]) !== base.ports[portName]) {
        if (!comment) problems.push(`[${section}] ${key} = ${match[1]} no coincide con el puerto ${portName} del perfil base (${base.ports[portName]}).`)
        return line
      }
      return `${indent}${comment}${key}${separator}${target.ports[portName]}${match[2]}`
    }
    if (section === "auth" && AUTH_URL_KEYS.has(key) && !comment) {
      const value = rawValue.replace(new RegExp(`(//(?:127\\.0\\.0\\.1|localhost)):${base.app.port}(?=\\D|$)`, "g"), `$1:${target.app.port}`)
      return `${indent}${key}${separator}${value}`
    }
    return line
  })
  if (!projectIdSeen) problems.push("config.toml no declara project_id.")

  if (base.projectId !== target.projectId) {
    const basePorts = [...Object.values(base.ports), base.app.port]
    for (const [location, value] of readConfigEntries(lines.join(eol))) {
      for (const port of basePorts) {
        if (new RegExp(`(^|\\D)${port}(\\D|$)`).test(value)) problems.push(`${location} conserva el puerto ${port} del perfil base.`)
      }
    }
  }
  if (problems.length > 0) {
    throw new BiblibError(EXIT.INVALID_ARGS, "perfil", `No se puede generar la configuración del perfil:\n- ${problems.join("\n- ")}`)
  }
  return lines.join(eol)
}

/**
 * Genera (o regenera) el workdir del perfil en `.biblib/stacks/<perfil>/` y el estado local
 * con la raíz real del checkout. No arranca servicios ni toca Docker.
 * @param {string} name
 * @param {{ root?: string, now?: Date }} [options]
 */
export function generateProfileWorkdir(name, options) {
  const root = rootOf(options)
  const manifest = loadProfiles(options)
  const base = getProfile(manifest.baseProfile, options)
  const target = getProfile(name, options)
  const baseToml = readText(path.join(root, manifest.baseConfig), "perfil")
  const rendered = renderProfileConfig(baseToml, base, target)
  const eol = baseToml.includes("\r\n") ? "\r\n" : "\n"
  const header = [
    `# GENERADO por scripts/lib/profiles.mjs para el perfil «${name}» a partir de ${manifest.baseConfig}.`,
    "# No editar: los cambios se pierden al regenerar. Modifica el archivo base o supabase/profiles.json.",
    "",
  ].join(eol)
  const content = `${header}${rendered}`

  const workdir = profileWorkdir(name, options)
  const supabaseDir = path.join(workdir, "supabase")
  mkdirSync(supabaseDir, { recursive: true })
  const configPath = path.join(supabaseDir, "config.toml")
  writeFileSync(configPath, content, "utf8")

  const fingerprint = rootFingerprint(options)
  const generatedAt = (options?.now ?? new Date()).toISOString()
  const stateDir = path.join(root, manifest.stateDir)
  writeFileSync(
    path.join(stateDir, "checkout.json"),
    `${JSON.stringify({ schemaVersion: 1, root: fingerprint.root, rootHash: fingerprint.hash, updatedAt: generatedAt }, null, 2)}\n`,
    "utf8",
  )
  const state = {
    schemaVersion: 1,
    profile: name,
    projectId: target.projectId,
    network: profileNetwork(name, options),
    ports: profilePorts(name, options),
    root: fingerprint.root,
    rootHash: fingerprint.hash,
    baseConfigSha256: createHash("sha256").update(baseToml).digest("hex"),
    configSha256: createHash("sha256").update(content).digest("hex"),
    generatedAt,
  }
  const statePath = path.join(workdir, "profile.json")
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8")
  return { workdir, configPath, statePath, state }
}

function main(argv) {
  const [command, name] = argv
  if (command === "generate" && name) {
    const { workdir, state } = generateProfileWorkdir(name)
    console.log(`Workdir del perfil «${name}» generado en ${workdir}`)
    console.log(`Proyecto ${state.projectId} · red ${state.network.name} · API ${LOOPBACK}:${state.ports.api}`)
    return EXIT.OK
  }
  if (command === "show" && name) {
    console.log(JSON.stringify({ ...getProfile(name), workdir: profileWorkdir(name), network: profileNetwork(name) }, null, 2))
    return EXIT.OK
  }
  console.error("Uso: node scripts/lib/profiles.mjs generate|show <perfil>")
  return EXIT.INVALID_ARGS
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    if (!(error instanceof BiblibError)) throw error
    console.error(`Error [${error.phase}]: ${error.message}`)
    process.exitCode = error.code
  }
}
