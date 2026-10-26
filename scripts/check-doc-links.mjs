// Enlaces relativos de la documentación (U-QA-05). Recorre los Markdown versionados de `docs/`, `README.md` y
// `agents.md` y comprueba que cada enlace relativo apunta a un archivo o carpeta existente dentro del repositorio.
// No abre red: los enlaces `http(s)`, `mailto` y los anclajes de la misma página no se comprueban, y de un enlace
// con anclaje solo se comprueba el archivo. Ignora el código entre comillas invertidas y los bloques de código.
//
//   node scripts/check-doc-links.mjs [--json] [ruta.md | carpeta ...]
//
// Salida: 0 sin enlaces rotos, 11 con enlaces rotos y 2 con argumentos no admitidos.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { EXIT } from "./lib/exit-codes.mjs"

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const DEFAULT_TARGETS = ["docs", "README.md", "agents.md"]
const SKIPPED_DIRS = new Set(["node_modules", ".git", ".next", ".biblib"])

/** Quita bloques de código y código en línea conservando los saltos de línea para numerar. */
export function stripCode(markdown) {
  const lines = markdown.split(/\r?\n/)
  let fence = null
  const kept = lines.map((line) => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null
      return ""
    }
    if (marker) {
      fence = marker[1]
      return ""
    }
    return line.replace(/(`+)[^`]*?\1/g, "")
  })
  return kept.join("\n")
}

/** Enlaces `[texto](destino)`, `![alt](destino)` y definiciones `[ref]: destino`, con su línea. */
export function extractLinks(markdown) {
  const links = []
  const lines = stripCode(markdown).split("\n")
  lines.forEach((line, index) => {
    for (const match of line.matchAll(/!?\[(?:[^\]\\]|\\.)*\]\(\s*(<[^>]*>|[^\s)]+(?:\([^\s)]*\)[^\s)]*)*)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g)) {
      links.push({ target: match[1].replace(/^<|>$/g, ""), line: index + 1 })
    }
    const definition = /^\s{0,3}\[[^\]]+\]:\s*(\S+)/.exec(line)
    if (definition) links.push({ target: definition[1].replace(/^<|>$/g, ""), line: index + 1 })
  })
  return links
}

/** Destino relativo comprobable en disco, o null si es externo o un anclaje local. */
export function relativeTarget(target) {
  if (!target || target.startsWith("#")) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) return null
  const withoutAnchor = target.split("#")[0].split("?")[0]
  if (!withoutAnchor) return null
  try {
    return decodeURIComponent(withoutAnchor)
  } catch {
    return withoutAnchor
  }
}

function listMarkdown(entry, root) {
  const absolute = path.resolve(root, entry)
  if (!existsSync(absolute)) return []
  if (statSync(absolute).isFile()) return absolute.endsWith(".md") ? [absolute] : []
  const files = []
  for (const item of readdirSync(absolute, { withFileTypes: true })) {
    if (item.isDirectory() && SKIPPED_DIRS.has(item.name)) continue
    const child = path.join(absolute, item.name)
    if (item.isDirectory()) files.push(...listMarkdown(child, root))
    else if (item.isFile() && item.name.endsWith(".md")) files.push(child)
  }
  return files
}

/** Comprueba los Markdown de `targets` y devuelve `{ files, links, broken[] }` con rutas relativas a `root`. */
export function checkDocLinks({ root = REPO_ROOT, targets = DEFAULT_TARGETS } = {}) {
  const files = [...new Set(targets.flatMap((entry) => listMarkdown(entry, root)))].sort()
  const broken = []
  let links = 0
  for (const file of files) {
    for (const link of extractLinks(readFileSync(file, "utf8"))) {
      const target = relativeTarget(link.target)
      if (target === null) continue
      links += 1
      const resolved = target.startsWith("/") ? path.join(root, target) : path.resolve(path.dirname(file), target)
      const outside = path.relative(root, resolved).startsWith("..")
      if (outside || !existsSync(resolved)) {
        broken.push({ file: path.relative(root, file).replaceAll("\\", "/"), line: link.line, target: link.target, reason: outside ? "fuera del repositorio" : "no existe" })
      }
    }
  }
  return { files: files.length, links, broken }
}

export function main(argv = process.argv.slice(2)) {
  const json = argv.includes("--json")
  const targets = argv.filter((arg) => arg !== "--json")
  if (targets.some((arg) => arg.startsWith("-"))) {
    console.error("Uso: node scripts/check-doc-links.mjs [--json] [ruta.md | carpeta ...]")
    return EXIT.INVALID_ARGS
  }
  const result = checkDocLinks({ targets: targets.length ? targets : DEFAULT_TARGETS })
  if (json) console.log(JSON.stringify(result, null, 2))
  else {
    for (const entry of result.broken) console.log(`${entry.file}:${entry.line} → ${entry.target} (${entry.reason})`)
    console.log(`${result.files} documento(s), ${result.links} enlace(s) relativo(s), ${result.broken.length} roto(s).`)
  }
  return result.broken.length ? EXIT.VERIFICATION_FAILED : EXIT.OK
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main()
