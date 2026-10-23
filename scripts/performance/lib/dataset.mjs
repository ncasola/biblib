import { createHash } from "node:crypto"

// Dataset sintético y determinista de la cuenta de escala (U-QA-03). Función pura: sin red, sin
// base de datos y sin datos reales. El libro i depende solo de (DATASET_ID, i): los 100 primeros
// libros de la escala 1000 son los de la escala 100, así los tamaños son comparables.

export const DATASET_ID = "biblib-escala-v1"
export const SCALES = Object.freeze([100, 1000, 10000])
export const SCALE_EMAIL = "escala@biblib.test"
/** Cantidad de estanterías (con la predeterminada) por escala: crece con la raíz del tamaño. */
const SHELF_TOTALS = Object.freeze({ 100: 6, 1000: 13, 10000: 41 })

const TITLE_LEAD = ["El", "La", "Los", "Las", "Un", "Una", "Breve historia de", "Atlas de", "Manual de", "Cuaderno de", "Memorias de", "Viaje a", "Teoría de", "Elogio de", "Diario de"]
const TITLE_NOUN = ["jardín", "faro", "biblioteca", "montaña", "isla", "ciudad", "río", "bosque", "reloj", "mapa", "puente", "taller", "archivo", "tormenta", "estación", "desierto", "caravana", "cometa", "molino", "laberinto", "mercado", "ventana", "orquesta", "invierno"]
const TITLE_TAIL = ["olvidado", "de papel", "de las mareas", "sin nombre", "de cristal", "interior", "del norte", "en llamas", "de la niebla", "nocturno", "de los sueños", "perdido", "mínimo", "azul", "de ceniza", "a la deriva", "infinito", "del señor Peñalver", "de Año Nuevo", "bajo la lluvia"]
const FIRST_NAMES = ["Alba", "Bruno", "Clara", "Dalia", "Elio", "Fabiola", "Gael", "Héctor", "Inés", "Jesús", "Karina", "Lázaro", "Marta", "Nicolás", "Olalla", "Pablo", "Quirino", "Rocío", "Sergio", "Teresa", "Ulises", "Violeta", "Wenceslao", "Ximena", "Yago", "Zoraida"]
const LAST_NAMES = ["Inventada", "Ficticio", "Imaginaria", "Supuesta", "Imaginado", "Soñador", "Aparente", "Hipotético", "Figurada", "Quimérico", "Legendaria", "Fabulado", "Peñalver", "Castañeda", "Muñoz", "Núñez", "Ibáñez", "Sáenz", "Ñíguez", "Lópezgarcía"]
const THEMES = ["Narrativa", "Ensayo", "Poesía", "Historia", "Ciencia", "Viajes", "Infantil", "Arte", "Filosofía", "Teatro", "Cómic", "Cocina", "Música", "Naturaleza", "Informática", "Referencia"]
const PUBLISHERS = ["Editorial Ficticia", "Ediciones del Faro", "Taller de Papel", "Imprenta Imaginaria", "Biblioteca Quimérica", "Sello de Prueba"]
const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"]
const STATUS_WEIGHTS = [["read", 40], ["to-read", 30], ["unread", 22], ["reading", 8]]
/** Fecha base fija de created_at para que el orden por creación sea reproducible. */
const BASE_TIME = Date.UTC(2024, 0, 1)

/** Mulberry32 con semilla de 32 bits derivada de un texto estable. */
export function rngFrom(text) {
  let state = createHash("sha256").update(text).digest().readUInt32LE(0)
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pick = (rng, list) => list[Math.floor(rng() * list.length)]

function weighted(rng, entries) {
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0)
  let point = rng() * total
  for (const [value, weight] of entries) { point -= weight; if (point < 0) return value }
  return entries.at(-1)[0]
}

/** ISBN-13 válido con prefijo 979-0, sin correspondencia con libros reales: 979 0 0 + 6 dígitos + control. */
export function scaleIsbn(index) {
  const body = `979000${String(index).padStart(6, "0")}`
  const sum = [...body].reduce((total, digit, i) => total + Number(digit) * (i % 2 ? 3 : 1), 0)
  return `${body}${(10 - (sum % 10)) % 10}`
}

export function isScale(value) {
  return SCALES.includes(value)
}

export function bookKey(index) {
  return `escala-${String(index).padStart(5, "0")}`
}

/** Estanterías de la escala: la predeterminada y `total - 1` temáticas con títulos únicos. */
export function shelvesFor(scale) {
  const total = SHELF_TOTALS[scale]
  if (!total) throw new RangeError(`Escala no admitida: ${scale}.`)
  const shelves = [{ fixtureKey: "default", title: "Sin estantería", isDefault: true }]
  for (let n = 1; n < total; n++) {
    shelves.push({ fixtureKey: `tema-${String(n).padStart(2, "0")}`, title: `Escala ${String(n).padStart(2, "0")} · ${THEMES[(n - 1) % THEMES.length]}`, isDefault: false })
  }
  return shelves
}

/** Pesos tipo Zipf: pocas estanterías grandes y una cola larga; la predeterminada recibe el 8 %. */
function shelfWeights(shelves) {
  const rest = shelves.slice(1)
  const raw = rest.map((_, k) => 1 / (k + 1) ** 0.8)
  const total = raw.reduce((sum, value) => sum + value, 0)
  return [[shelves[0].fixtureKey, 8], ...rest.map((shelf, k) => [shelf.fixtureKey, (raw[k] / total) * 92])]
}

/** Libro `index` (1…N). `shelfKeys` fija el reparto; el resto depende solo del índice. */
export function bookAt(index, shelves) {
  const rng = rngFrom(`${DATASET_ID}:book:${index}`)
  const manual = rng() < 0.15
  const authorCount = weighted(rng, [[1, 70], [2, 25], [3, 5]])
  const authors = Array.from({ length: authorCount }, () => ({ name: `${pick(rng, FIRST_NAMES)} ${pick(rng, LAST_NAMES)}` }))
  const lead = pick(rng, TITLE_LEAD)
  const volume = rng() < 0.12 ? ` (vol. ${1 + Math.floor(rng() * 9)})` : ""
  const title = `${lead} ${pick(rng, TITLE_NOUN)} ${pick(rng, TITLE_TAIL)}${volume}`
  const hasSubtitle = rng() < 0.35
  const dateRoll = rng()
  const year = 1950 + Math.floor(rng() * 77)
  const publishDate = dateRoll < 0.8 ? String(year) : dateRoll < 0.9 ? `${1 + Math.floor(rng() * 28)} de ${pick(rng, MONTHS)} de ${year}` : ""
  const created = new Date(BASE_TIME + index * 600_000)
  return {
    fixtureKey: bookKey(index),
    isbn: manual ? `manual-${bookKey(index)}` : scaleIsbn(index),
    title,
    subtitle: hasSubtitle ? `${pick(rng, TITLE_TAIL)} · ${pick(rng, THEMES)}` : null,
    authors,
    publishers: [{ name: pick(rng, PUBLISHERS) }],
    number_of_pages: 40 + Math.floor(rng() ** 2 * 1160),
    publish_date: publishDate,
    status: weighted(rng, STATUS_WEIGHTS),
    shelfKey: weighted(rng, shelfWeights(shelves)),
    source: manual ? "manual" : "open-library",
    createdAt: created.toISOString(),
    updatedAt: new Date(created.getTime() + Math.floor(rng() * 86_400_000)).toISOString(),
  }
}

export function scaleDataset(scale) {
  const shelves = shelvesFor(scale)
  const books = Array.from({ length: scale }, (_, i) => bookAt(i + 1, shelves))
  return { datasetId: DATASET_ID, scale, shelves, books }
}

/** Resumen sin contenido de fichas: reparto por estado y estantería (para el informe y las pruebas). */
export function summarize(dataset) {
  const byStatus = {}
  const byShelf = {}
  for (const book of dataset.books) {
    byStatus[book.status] = (byStatus[book.status] ?? 0) + 1
    byShelf[book.shelfKey] = (byShelf[book.shelfKey] ?? 0) + 1
  }
  return { scale: dataset.scale, shelves: dataset.shelves.length, books: dataset.books.length, byStatus, largestShelf: Math.max(...Object.values(byShelf)), manualIsbn: dataset.books.filter((b) => b.isbn.startsWith("manual-")).length }
}

/** Huella estable del contenido del dataset: dos ejecuciones deben coincidir byte a byte. */
export function datasetHash(dataset) {
  return createHash("sha256").update(JSON.stringify(dataset)).digest("hex")
}
