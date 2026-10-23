import assert from "node:assert/strict"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { test } from "node:test"

// U-BIB-05 · Un solo camino hacia los catálogos. Prueba estática sobre el árbol de código fuente:
// ningún nombre de host de Open Library o BNE fuera de lib/bibliographic-catalog/providers/ y ningún
// `fetch` directo a un destino absoluto fuera del adaptador y del gateway.

const PROVIDERS_DIR = "lib/bibliographic-catalog/providers/"
const SOURCE_DIRECTORIES = ["app", "components", "hooks", "lib", "scripts"]
const SOURCE_FILES = ["proxy.ts", "next.config.mjs", "drizzle.config.ts"]
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/
const PROVIDER_HOST = /openlibrary\.org|catalogo\.bne\.es/i
// Cabeceras y CSP pueden nombrar el host de imágenes: es una lista de lo que el navegador puede mostrar,
// no una consulta. Solo ese host y solo en la configuración de la aplicación.
const IMAGE_HOST_CONFIGURATION = new Set(["next.config.mjs", "proxy.ts"])
// Únicos módulos con `fetch` hacia el exterior: el gateway (fetch por defecto, con reserva de cuota) y los adaptadores.
const NETWORK_MODULES = ["lib/bibliographic-catalog/gateway.ts"]

export interface EgressViolation { file: string; line: number; rule: "host" | "fetch"; text: string }

function isProviderModule(file: string): boolean {
  return file.startsWith(PROVIDERS_DIR) || NETWORK_MODULES.includes(file)
}

/** Líneas que rompen la regla. `files` asocia ruta relativa con contenido; es pura para poder probarla con datos sintéticos. */
export function findEgressViolations(files: ReadonlyMap<string, string>): EgressViolation[] {
  const violations: EgressViolation[] = []
  for (const [file, content] of files) {
    const lines = content.split(/\r?\n/)
    lines.forEach((text, index) => {
      const line = index + 1
      if (!file.startsWith(PROVIDERS_DIR) && PROVIDER_HOST.test(text)) {
        const onlyImageHost = IMAGE_HOST_CONFIGURATION.has(file) && !/catalogo\.bne\.es/i.test(text) && !/(?<!covers\.)openlibrary\.org/i.test(text)
        if (!onlyImageHost) violations.push({ file, line, rule: "host", text: text.trim() })
      }
      // Los scripts de operación (smoke, CI) tienen su propio `fetch` hacia el stack local; solo se vigila el código de la aplicación.
      if (isProviderModule(file) || file.startsWith("scripts/")) return
      for (const match of text.matchAll(/\bfetch\s*\(\s*(.?)/g)) {
        // Solo se admiten rutas propias de la aplicación («/api/…»); cualquier otro destino o variable se revisa.
        const next = text.slice((match.index ?? 0) + match[0].length - match[1].length)
        if (!/^[`"']\//.test(next)) violations.push({ file, line, rule: "fetch", text: text.trim() })
      }
    })
  }
  return violations
}

function collect(root: string): Map<string, string> {
  const files = new Map<string, string>()
  const visit = (relative: string) => {
    const absolute = path.join(root, relative)
    if (!existsSync(absolute)) return
    if (statSync(absolute).isDirectory()) {
      for (const entry of readdirSync(absolute)) if (entry !== "node_modules" && !entry.startsWith(".")) visit(`${relative}/${entry}`)
    } else if (SOURCE_FILE.test(relative)) files.set(relative, readFileSync(absolute, "utf8"))
  }
  for (const directory of SOURCE_DIRECTORIES) visit(directory)
  for (const file of SOURCE_FILES) visit(file)
  return files
}

test("la prueba detecta hosts de catálogo y fetch directos fuera de los adaptadores", () => {
  const files = new Map<string, string>([
    ["lib/bibliographic-catalog/providers/open-library.ts", 'const url = new URL("https://openlibrary.org/api/books")\nawait fetch(url)'],
    ["lib/bibliographic-catalog/gateway.ts", "const baseFetch = (...args) => fetch(...args)"],
    ["components/panel.tsx", 'await fetch("https://openlibrary.org/api/books?bibkeys=ISBN:1")'],
    ["lib/library-import.ts", 'const response = await fetch(url, { headers })'],
    ["app/books/add/screen.tsx", "const response = await fetch(`/api/books/search?isbn=${isbn}`)"],
    ["app/actions/otro.ts", 'const url = "https://catalogo.bne.es/view/sru/34BNE_INST"'],
    ["next.config.mjs", 'remotePatterns: [{ hostname: "covers.openlibrary.org" }]'],
    ["proxy.ts", 'const csp = "img-src https://openlibrary.org"'],
    ["scripts/smoke.mjs", "await fetch(`${origin}/login`)"],
  ])
  assert.deepEqual(findEgressViolations(files).map(({ file, line, rule }) => `${file}:${line}:${rule}`), [
    "components/panel.tsx:1:host",
    "components/panel.tsx:1:fetch",
    "lib/library-import.ts:1:fetch",
    "app/actions/otro.ts:1:host",
    "proxy.ts:1:host",
  ])
  assert.deepEqual(findEgressViolations(new Map([["lib/limpio.ts", 'import { bibliographicCatalog } from "./bibliographic-catalog/server"']])), [])
})

test("ningún componente, acción, trabajo ni módulo de lib sale a Open Library o BNE fuera del orquestador", () => {
  const files = collect(process.cwd())
  assert.ok(files.size > 100, "El árbol de código fuente debe estar cargado")
  for (const required of ["lib/library-import.ts", "lib/jobs/worker.ts", "app/actions/books.ts", "app/actions/import-preview.ts", "app/actions/cover-recovery.ts", "components/cover-recovery-job-panel.tsx", "lib/bibliographic-catalog/providers/open-library.ts"]) {
    assert.ok(files.has(required), `Falta ${required} en el recorrido`)
  }
  assert.deepEqual(findEgressViolations(files), [])
})

test("los cuatro flujos importan el catálogo del módulo de servidor y ninguno crea un adaptador propio", () => {
  const files = collect(process.cwd())
  const adapters = /createOpenLibraryProvider|createBneSruProvider|createGoogleBooksProvider|createOpenLibraryClient/
  const outside = [...files].filter(([file, content]) => adapters.test(content) && !file.startsWith(PROVIDERS_DIR) &&
    // Fachada legacy sobre el adaptador y registro que ensambla el servicio configurado.
    !["lib/open-library.ts", "lib/bibliographic-catalog/registry.ts"].includes(file)).map(([file]) => file)
  assert.deepEqual(outside, [])
})

test("la preparación de la importación no consulta catálogos y las portadas pendientes las busca el trabajo", () => {
  const read = (file: string) => readFileSync(file, "utf8")
  for (const file of ["lib/library-import.ts", "app/actions/import-preview.ts", "lib/import-plan.ts", "lib/import-publisher.ts"]) {
    assert.ok(!/bibliographic-catalog|enrichImportedBookCovers|getCover\(/.test(read(file)), `${file} no debe consultar catálogos`)
  }
  assert.ok(/seedCoverItems\(outcome\.insertedBookIds\)/.test(read("lib/jobs/worker.ts")), "tras publicar, las portadas pendientes pasan al trabajo de portadas")
  // La recuperación pasa por el trabajo; «Buscar portada» por el orquestador de servidor.
  assert.ok(/startCoverJobAction/.test(read("app/actions/cover-recovery.ts")))
  assert.ok(/bibliographicCatalog\.getCover\(/.test(read("app/actions/books.ts")))
})
