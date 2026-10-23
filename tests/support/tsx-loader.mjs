// Loader de pruebas de componente (U-BIB-04): transpila .ts/.tsx del repositorio con TypeScript,
// resuelve el alias `@/` y sustituye next/image y next/link por elementos HTML simples. Solo se
// registra desde pruebas que renderizan componentes con react-dom/server; no afecta al build.
import { existsSync, statSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import ts from "typescript"

const root = process.cwd()
const stubs = {
  "next/image": `import { createElement } from "react"
export default function Image({ src, alt, fill, sizes, priority, onError, ...rest }) { return createElement("img", { src: typeof src === "string" ? src : "", alt, ...rest }) }`,
  "next/link": `import { createElement } from "react"
export default function Link({ href, prefetch, replace, scroll, children, ...rest }) { return createElement("a", { href: typeof href === "string" ? href : "#", ...rest }, children) }`,
}

const isFile = (file) => existsSync(file) && statSync(file).isFile()

function localFile(base) {
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (isFile(candidate) && /\.(tsx?|json)$/.test(candidate)) return candidate
  }
  return null
}

export async function resolve(specifier, context, next) {
  if (specifier in stubs) return { url: `biblib-stub:${specifier}`, shortCircuit: true }
  // Los stubs importan React como si estuvieran en la raíz del repositorio.
  if (context.parentURL?.startsWith("biblib-stub:")) return next(specifier, { ...context, parentURL: pathToFileURL(path.join(root, "package.json")).href })
  const parent = context.parentURL?.startsWith("file:") ? fileURLToPath(context.parentURL) : null
  const base = specifier.startsWith("@/") ? path.join(root, specifier.slice(2))
    : parent && !parent.includes(`${path.sep}node_modules${path.sep}`) && /^\.\.?\//.test(specifier) ? path.resolve(path.dirname(parent), specifier) : null
  const file = base && localFile(base)
  if (file) return { url: pathToFileURL(file).href, shortCircuit: true }
  return next(specifier, context)
}

export async function load(url, context, next) {
  if (url.startsWith("biblib-stub:")) return { format: "module", source: stubs[url.slice("biblib-stub:".length)], shortCircuit: true }
  if (url.startsWith("file:") && /\.tsx?$/.test(url) && !url.includes("/node_modules/")) {
    const file = fileURLToPath(url)
    const { outputText } = ts.transpileModule(await readFile(file, "utf8"), {
      fileName: file,
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    })
    return { format: "module", source: outputText, shortCircuit: true }
  }
  if (url.startsWith("file:") && url.endsWith(".json") && !url.includes("/node_modules/")) {
    return { format: "json", source: await readFile(fileURLToPath(url), "utf8"), shortCircuit: true, importAttributes: { type: "json" } }
  }
  return next(url, context)
}
