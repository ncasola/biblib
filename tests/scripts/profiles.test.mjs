import assert from "node:assert/strict"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, describe, test } from "node:test"
import { fileURLToPath } from "node:url"
import { BiblibError, EXIT, describeExit } from "../../scripts/lib/exit-codes.mjs"
import {
  CONFIG_PORT_KEYS,
  FOREIGN_PORTS,
  HOST_BINDING_OPTION,
  LOOPBACK,
  generateProfileWorkdir,
  getProfile,
  loadProfiles,
  profileNetwork,
  profilePorts,
  profileWorkdir,
  readConfigEntries,
  renderProfileConfig,
  validateProfiles,
} from "../../scripts/lib/profiles.mjs"

const root = fileURLToPath(new URL("../../", import.meta.url))
const baseToml = readFileSync(path.join(root, "supabase/config.toml"), "utf8")
const manifest = loadProfiles()
const names = Object.keys(manifest.profiles)

const temporaryRoots = []
function temporaryCheckout() {
  const dir = mkdtempSync(path.join(tmpdir(), "biblib-profiles-"))
  temporaryRoots.push(dir)
  mkdirSync(path.join(dir, "supabase"))
  copyFileSync(path.join(root, "supabase/config.toml"), path.join(dir, "supabase/config.toml"))
  copyFileSync(path.join(root, "supabase/profiles.json"), path.join(dir, "supabase/profiles.json"))
  return dir
}
after(() => {
  for (const dir of temporaryRoots) rmSync(dir, { recursive: true, force: true })
})

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

describe("manifiesto de perfiles", () => {
  test("declara main, test y scratch con identidades propias", () => {
    assert.deepEqual(names.sort(), ["main", "scratch", "test"])
    assert.equal(manifest.baseProfile, "main")
    assert.deepEqual(validateProfiles(manifest), [])
    assert.equal(getProfile("main").projectId, "biblib-local")
    assert.equal(getProfile("test").projectId, "biblib-test")
    assert.equal(getProfile("scratch").projectId, "biblib-scratch")
  })

  test("cada perfil ocupa su bloque de diez puertos y su puerto de aplicación", () => {
    const expected = { main: [55320, 3147], test: [55330, 3148], scratch: [55340, 3149] }
    for (const [name, [first, app]] of Object.entries(expected)) {
      const ports = profilePorts(name)
      assert.equal(ports.app, app)
      assert.deepEqual(
        Object.keys(CONFIG_PORT_KEYS).map((key) => ports[key]),
        Array.from({ length: 10 }, (_, index) => first + index),
        `bloque de ${name}`,
      )
    }
  })

  test("no hay solapes entre perfiles ni con 5432/54320–54329", () => {
    const all = names.flatMap((name) => Object.values(profilePorts(name)))
    assert.equal(new Set(all).size, all.length)
    for (const port of all) assert.ok(!FOREIGN_PORTS.includes(port), `puerto ajeno ${port}`)
    assert.ok(FOREIGN_PORTS.includes(5432) && FOREIGN_PORTS.includes(54320) && FOREIGN_PORTS.includes(54329))
  })

  test("declara bindings en loopback y una red propia por perfil", () => {
    assert.equal(manifest.bindAddress, LOOPBACK)
    for (const name of names) {
      const profile = getProfile(name)
      assert.equal(profile.bindAddress, "127.0.0.1")
      assert.equal(profile.app.host, "127.0.0.1")
      const network = profileNetwork(name)
      assert.equal(network.name, `${profile.projectId}-network`)
      assert.deepEqual(network.driverOptions, { [HOST_BINDING_OPTION]: "127.0.0.1" })
      assert.equal(network.labels["biblib.profile"], name)
      assert.match(network.labels["biblib.root"], /^[a-f0-9]{16}$/)
    }
  })

  test("detecta solapes, puertos ajenos y bindings externos", () => {
    const overlapping = clone(manifest)
    overlapping.profiles.scratch.ports.api = overlapping.profiles.test.ports.api
    assert.ok(validateProfiles(overlapping).some((problem) => problem.includes("ya lo usa")))

    const foreign = clone(manifest)
    foreign.profiles.test.ports.db = 54322
    assert.ok(validateProfiles(foreign).some((problem) => problem.includes("otro stack")))

    const exposed = clone(manifest)
    exposed.bindAddress = "0.0.0.0"
    exposed.profiles.main.app.host = "0.0.0.0"
    assert.equal(validateProfiles(exposed).filter((problem) => problem.includes(LOOPBACK)).length, 2)

    const network = clone(manifest)
    network.profiles.main.network = "supabase_network_biblib"
    assert.ok(validateProfiles(network).some((problem) => problem.includes("biblib-local-network")))
  })

  test("un perfil desconocido es un error de argumentos (exit 2)", () => {
    assert.throws(() => getProfile("produccion"), (error) => error instanceof BiblibError && error.code === EXIT.INVALID_ARGS && error.phase === "perfil")
    assert.throws(() => getProfile("toString"), BiblibError)
  })
})

describe("supabase/config.toml del perfil main", () => {
  const entries = readConfigEntries(baseToml)

  test("coincide con la identidad y los puertos de main", () => {
    const main = getProfile("main")
    assert.equal(entries.get("project_id"), `"${main.projectId}"`)
    for (const [name, location] of Object.entries(CONFIG_PORT_KEYS)) {
      const value = entries.get(`${location.section}.${location.key}`)
      if (value === undefined) continue
      assert.equal(Number(value), main.ports[name], `${location.section}.${location.key}`)
    }
    assert.match(entries.get("auth.site_url"), /^"http:\/\/127\.0\.0\.1:3147"$/)
  })

  test("no activa migraciones ni seed de usuario del CLI", () => {
    assert.equal(entries.get("db.migrations.enabled"), "false")
    assert.equal(entries.get("db.migrations.schema_paths"), "[]")
    assert.equal(entries.get("db.seed.enabled"), "false")
    assert.equal(entries.get("db.seed.sql_paths"), "[]")
  })

  test("no expone el esquema biblib por la Data API", () => {
    const schemas = entries.get("api.schemas")
    assert.ok(schemas)
    assert.doesNotMatch(schemas, /biblib/)
    assert.doesNotMatch(entries.get("api.extra_search_path") ?? "", /biblib/)
  })

  test("usa Postgres 17 y solo los servicios previstos", () => {
    assert.equal(entries.get("db.major_version"), "17")
    for (const section of ["api", "auth", "storage", "studio", "local_smtp"]) {
      assert.equal(entries.get(`${section}.enabled`), "true", `${section} habilitado`)
    }
    for (const section of ["analytics", "edge_runtime", "db.pooler", "realtime"]) {
      assert.equal(entries.get(`${section}.enabled`), "false", `${section} deshabilitado`)
    }
    assert.ok(!entries.has("inbucket.enabled"), "la plantilla 2.117.0 usa [local_smtp]")
  })

  test("no lee secretos de Studio desde el entorno", () => {
    assert.ok(!entries.has("studio.openai_api_key"))
  })

  test("supabase/migrations no contiene SQL", () => {
    const dir = path.join(root, "supabase/migrations")
    const files = existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String) : []
    assert.deepEqual(files.filter((file) => file.toLowerCase().endsWith(".sql")), [])
  })
})

describe("workdir generado por perfil", () => {
  test("profileWorkdir apunta a .biblib/stacks/<perfil>/", () => {
    for (const name of names) {
      assert.equal(profileWorkdir(name), path.join(root, ".biblib", "stacks", name))
    }
  })

  for (const name of ["scratch", "test"]) {
    test(`genera ${name} con su projectId, puertos y URL de aplicación`, () => {
      const checkout = temporaryCheckout()
      const profile = getProfile(name, { root: checkout })
      const { workdir, configPath, state } = generateProfileWorkdir(name, { root: checkout, now: new Date("2026-10-23T00:00:00Z") })
      assert.equal(workdir, path.join(checkout, ".biblib", "stacks", name))
      assert.equal(configPath, path.join(workdir, "supabase", "config.toml"))

      const generated = readFileSync(configPath, "utf8")
      const entries = readConfigEntries(generated)
      assert.equal(entries.get("project_id"), `"${profile.projectId}"`)
      for (const [portName, location] of Object.entries(CONFIG_PORT_KEYS)) {
        const value = entries.get(`${location.section}.${location.key}`)
        if (value !== undefined) assert.equal(Number(value), profile.ports[portName], `${location.section}.${location.key}`)
      }
      assert.equal(entries.get("auth.site_url"), `"http://127.0.0.1:${profile.app.port}"`)
      assert.match(entries.get("auth.additional_redirect_urls"), new RegExp(`127\\.0\\.0\\.1:${profile.app.port}/auth/callback`))
      assert.equal(entries.get("db.migrations.enabled"), "false")
      assert.equal(entries.get("db.seed.enabled"), "false")

      const main = profilePorts("main", { root: checkout })
      const values = [...entries.values()].join("\n")
      for (const port of Object.values(main)) assert.ok(!values.includes(String(port)), `queda el puerto ${port} de main`)

      // Fuera de identidad, puertos y app, el archivo generado es idéntico al base.
      const baseEntries = readConfigEntries(baseToml)
      const changed = [...entries].filter(([key, value]) => baseEntries.get(key) !== value).map(([key]) => key).sort()
      assert.deepEqual(changed, ["analytics.port", "api.port", "auth.additional_redirect_urls", "auth.site_url", "db.pooler.port", "db.port", "db.shadow_port", "edge_runtime.inspector_port", "local_smtp.port", "project_id", "studio.port"])

      assert.equal(state.profile, name)
      assert.equal(state.projectId, profile.projectId)
      assert.equal(state.network.name, `${profile.projectId}-network`)
      assert.match(state.rootHash, /^[a-f0-9]{64}$/)
      const checkoutState = JSON.parse(readFileSync(path.join(checkout, ".biblib", "checkout.json"), "utf8"))
      assert.equal(checkoutState.rootHash, state.rootHash)
      assert.equal(state.network.labels["biblib.root"], state.rootHash.slice(0, 16))
    })
  }

  test("el workdir de main reproduce el config.toml base", () => {
    const checkout = temporaryCheckout()
    const { configPath } = generateProfileWorkdir("main", { root: checkout })
    assert.deepEqual(readConfigEntries(readFileSync(configPath, "utf8")), readConfigEntries(baseToml))
  })

  test("rechaza un config.toml que no coincide con el perfil base", () => {
    const main = getProfile("main")
    const scratch = getProfile("scratch")
    const drifted = baseToml.replace(/^port = 55321$/m, "port = 54321")
    assert.notEqual(drifted, baseToml)
    assert.throws(() => renderProfileConfig(drifted, main, scratch), (error) => error instanceof BiblibError && error.code === EXIT.INVALID_ARGS && /55321/.test(error.message))
    assert.throws(() => renderProfileConfig(baseToml.replace('"biblib-local"', '"otro"'), main, scratch), /project_id/)
  })

  test("conserva los saltos de línea CRLF del archivo base", () => {
    const rendered = renderProfileConfig(baseToml.replace(/\r?\n/g, "\r\n"), getProfile("main"), getProfile("scratch"))
    assert.ok(!/[^\r]\n/.test(rendered))
  })
})

describe("códigos de salida", () => {
  test("EXIT contiene exactamente 0, 2–11 y 130", () => {
    assert.deepEqual(Object.values(EXIT).sort((a, b) => a - b), [0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 130])
    for (const code of Object.values(EXIT)) assert.notEqual(describeExit(code), "Código de salida desconocido.")
  })

  test("BiblibError conserva código, fase y mensaje", () => {
    const error = new BiblibError(EXIT.SERVICE_UNAVAILABLE, "preflight", "Docker no responde.")
    assert.ok(error instanceof Error)
    assert.equal(error.name, "BiblibError")
    assert.deepEqual(error.toJSON(), { code: 8, phase: "preflight", message: "Docker no responde." })
    assert.throws(() => new BiblibError(0, "fase", "éxito no es error"), TypeError)
    assert.throws(() => new BiblibError(1, "fase", "código fuera de contrato"), TypeError)
    assert.throws(() => new BiblibError(EXIT.INVALID_ARGS, "", "sin fase"), TypeError)
  })
})
