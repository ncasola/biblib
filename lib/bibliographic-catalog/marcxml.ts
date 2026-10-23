import { XMLParser, XMLValidator } from "fast-xml-parser"
import { normalizeIsbn } from "../isbn"
import { normalizeCandidate } from "./normalize"
import type { BibliographicCandidate } from "./types"

export const MAX_BNE_XML_BYTES = 524288
const SRU = "http://www.loc.gov/zing/srw/"
const MARC = "http://www.loc.gov/MARC21/slim"
const EXPLAIN = "http://explain.z3950.org/dtd/2.0/"
const namespaces = new Set([SRU, MARC, EXPLAIN, "http://explain.z3950.org/dtd/2.1/", "http://www.loc.gov/zing/srw/diagnostic/", "http://www.w3.org/2001/XMLSchema-instance", "http://www.w3.org/XML/1998/namespace", "http://www.exlibris.com/repository/search/xmlbeans/"])
interface Element { name: string; namespace: string; attributes: Record<string, string>; children: Element[]; text: string }
function invalid(): never { throw new Error("La respuesta MARCXML no es válida o excede los límites permitidos.") }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid()
  return value as Record<string, unknown>
}

function decode(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_match, entity: string) => {
    if (entity.startsWith("#")) {
      const code = entity[1].toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1))
      if (!(code === 9 || code === 10 || code === 13 || code >= 32 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff))) return invalid()
      return String.fromCodePoint(code)
    }
    const predefined: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }
    return predefined[entity] ?? invalid()
  })
}

/** Sin DTD, entidades definidas, CDATA ni instrucciones de proceso externas. */
function parse(xml: string, maxBytes = MAX_BNE_XML_BYTES): Element {
  if (Buffer.byteLength(xml, "utf8") > Math.min(maxBytes, MAX_BNE_XML_BYTES) || /<!/i.test(xml) || /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/i.test(xml)) return invalid()
  if (/<\?(?!xml\s)/i.test(xml)) return invalid()
  // El límite de profundidad se comprueba ANTES de invocar el parser/validador.
  let depth = 0
  let nodes = 0
  for (const match of xml.matchAll(/<(?:(?:"[^"]*"|'[^']*'|[^'">])*)>/g)) {
    const tag = match[0]
    if (tag.startsWith("<?")) continue
    if (tag.startsWith("</")) depth--
    else { nodes++; if (!tag.endsWith("/>")) depth++ }
    if (depth < 0 || depth > 24 || nodes > 20000) return invalid()
  }
  if (depth !== 0 || XMLValidator.validate(xml) !== true) return invalid()
  const parsed: unknown = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: "", processEntities: false, parseTagValue: false, parseAttributeValue: false, trimValues: false, ignoreDeclaration: true }).parse(xml)
  function elements(input: unknown, inherited: Record<string, string>): Element[] {
    if (!Array.isArray(input)) return invalid()
    const result: Element[] = []
    for (const item of input) {
      const entry = object(item)
      if ("#text" in entry) continue
      const names = Object.keys(entry).filter((key) => key !== ":@")
      if (names.length !== 1) return invalid()
      const qualified = names[0]
      const attributes: Record<string, string> = {}
      const bindings = { ...inherited }
      for (const [key, raw] of Object.entries(entry[":@"] ? object(entry[":@"]) : {})) {
        if (typeof raw !== "string") return invalid()
        const value = decode(raw)
        if (key === "xmlns" || key.startsWith("xmlns:")) {
          if (!namespaces.has(value)) return invalid()
          bindings[key === "xmlns" ? "" : key.slice(6)] = value
        } else attributes[key] = value
      }
      const split = qualified.split(":")
      if (split.length > 2) return invalid()
      const namespace = bindings[split.length === 2 ? split[0] : ""]
      if (!namespace || !namespaces.has(namespace)) return invalid()
      for (const key of Object.keys(attributes)) if (key.includes(":") && !bindings[key.split(":")[0]]) return invalid()
      const children = entry[qualified]
      if (!Array.isArray(children)) return invalid()
      const text = children.map((child: unknown) => {
        const node = object(child)
        if (!("#text" in node)) return ""
        if (typeof node["#text"] !== "string") return invalid()
        return decode(node["#text"])
      }).join("")
      result.push({ name: split.at(-1)!, namespace, attributes, children: elements(children, bindings), text })
    }
    return result
  }
  const roots = elements(parsed, { xml: "http://www.w3.org/XML/1998/namespace" })
  if (roots.length !== 1) return invalid()
  return roots[0]
}
function children(node: Element, name: string, namespace = node.namespace): Element[] { return node.children.filter((child) => child.name === name && child.namespace === namespace) }
function single(node: Element, name: string, namespace = node.namespace): Element | undefined {
  const found = children(node, name, namespace)
  if (found.length > 1) return invalid()
  return found[0]
}
function text(node?: Element): string | undefined {
  if (!node) return undefined
  if (node.children.length) return invalid()
  return node.text.trim() || undefined
}
function clean(value?: string): string | undefined { return value?.replace(/\s+([:;/])?\s*$/, "").trim() || undefined }
function fields(record: Element, tag: string): Element[] { return children(record, "datafield", MARC).filter((field) => field.attributes.tag === tag) }
function values(field: Element, code: string): string[] { return children(field, "subfield", MARC).filter((subfield) => subfield.attributes.code === code).map((subfield) => text(subfield)).filter((value): value is string => Boolean(value)) }
function control(record: Element, tag: string): string | undefined { return text(children(record, "controlfield", MARC).find((field) => field.attributes.tag === tag)) }

function mapRecord(record: Element, identifier: string | undefined, retrievedAt: string, isbn?: string): BibliographicCandidate {
  const id = control(record, "001") ?? identifier
  if (!id || !/^[\w-]{1,200}$/.test(id)) return invalid()
  const title = fields(record, "245")[0]
  const publication = fields(record, "264").find((field) => field.attributes.ind2 === "1") ?? fields(record, "260")[0]
  const physical = fields(record, "300")[0]
  const extent = physical ? values(physical, "a")[0] : undefined
  const pages = extent?.match(/^(\d+)\s+(?:p\.|páginas?\b|pages?\b)/i)
  const description = physical ? ["a", "b", "c"].flatMap((code) => values(physical, code)).join(" ; ") : undefined
  const language = fields(record, "041").flatMap((field) => values(field, "a"))[0] ?? control(record, "008")?.slice(35, 38).trim()
  const creators = [...fields(record, "100"), ...fields(record, "700").filter((field) => {
    const roles = values(field, "4")
    const labels = values(field, "e")
    return roles.length ? roles.includes("aut") : !labels.length || labels.some((label) => /^autor(?:a)?[.,]?$/i.test(label))
  })]
  const isbns = fields(record, "020").flatMap((field) => values(field, "a")).flatMap((value) => {
    const original = value.split(/\s*\(/)[0].trim()
    return normalizeIsbn(original) ? [original] : []
  })
  return normalizeCandidate({
    provider: "bne", level: "edition", recordId: id,
    sourceUrl: id ? `https://catalogo.bne.es/discovery/fulldisplay?docid=alma${encodeURIComponent(id)}&context=L&vid=34BNE_INST:CATALOGO` : undefined,
    isbns, title: title ? clean(values(title, "a")[0]) : undefined, subtitle: title ? clean(values(title, "b")[0]) : undefined,
    authors: creators.flatMap((field) => values(field, "a")).map((name) => ({ name: clean(name) ?? name })),
    publishers: publication ? values(publication, "b").map((name) => ({ name: clean(name) ?? name })) : [],
    publishDate: publication ? clean(values(publication, "c")[0]) : undefined,
    language: language && /^[a-z]{3}$/i.test(language) ? language : undefined,
    format: description && description.length <= 100 ? description : undefined,
    numberOfPages: pages && Number(pages[1]) <= 100000 ? Number(pages[1]) : undefined,
    evidence: { isbnExact: false }, retrievedAt,
  }, isbn)
}

export function parseBneSearchRetrieve(xml: string, options: { retrievedAt: string; isbn?: string; maximumRecords?: number; maxBytes?: number }): BibliographicCandidate[] {
  const root = parse(xml, options.maxBytes)
  if (root.namespace !== SRU || root.name !== "searchRetrieveResponse" || text(single(root, "version")) !== "1.2" || root.children.some((node) => node.name === "diagnostics")) return invalid()
  const totalText = text(single(root, "numberOfRecords"))
  if (!totalText || !/^\d+$/.test(totalText) || !Number.isSafeInteger(Number(totalText))) return invalid()
  const total = Number(totalText)
  const wrapper = single(root, "records")
  const records = wrapper ? children(wrapper, "record", SRU) : []
  if (records.length > Math.min(options.maximumRecords ?? 10, 10) || records.length > total || total > 0 && !records.length) return invalid()
  const positions = new Set<number>()
  return records.map((record) => {
    const position = Number(text(single(record, "recordPosition")))
    if (!Number.isSafeInteger(position) || position < 1 || position > total || positions.has(position)) return invalid()
    positions.add(position)
    if (!["marcxml", MARC].includes(text(single(record, "recordSchema")) ?? "") || text(single(record, "recordPacking")) !== "xml") return invalid()
    const data = single(record, "recordData")
    const marc = data && single(data, "record", MARC)
    if (!marc) return invalid()
    return { position, candidate: mapRecord(marc, text(single(record, "recordIdentifier")), options.retrievedAt, options.isbn) }
  }).sort((a, b) => a.position - b.position).map(({ candidate }) => candidate)
}

/** Explain se valida offline o mediante una llamada explícita, nunca por cada consulta. */
export function parseBneExplain(xml: string): { indexes: string[] } {
  const root = parse(xml)
  if (root.name !== "explainResponse" || root.namespace !== SRU || text(single(root, "version")) !== "1.2") return invalid()
  const data = single(root, "record")
  const recordData = data && single(data, "recordData")
  const explain = recordData && single(recordData, "explain", EXPLAIN)
  const indexInfo = explain && single(explain, "indexInfo")
  if (!indexInfo) return invalid()
  const indexes = children(indexInfo, "index").flatMap((index) => children(index, "map").flatMap((map) => children(map, "name").map((name) => `${name.attributes.set}.${text(name)}`)))
  if (!["alma.isbn", "alma.title", "alma.creator"].every((index) => indexes.includes(index))) return invalid()
  return { indexes: indexes.filter((index) => ["alma.isbn", "alma.title", "alma.creator"].includes(index)) }
}
