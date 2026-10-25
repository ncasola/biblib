import { z } from "zod"
import { DomainError } from "./domain-errors"
import { LOCATION_KIND_LABELS, LOCATION_KINDS, LOCATION_LIMITS, type LocationKind } from "./product/contracts"

// Ubicación física (U-PRO-03): validación de entradas, árbol y ruta legible. Funciones puras, válidas en cliente y servidor.
// Los límites, los ciclos y la profundidad los impone también Postgres (0014); aquí solo se anticipan para dar un mensaje
// claro antes de escribir. La ubicación física nunca es la estantería lógica (`shelf_id`).

/** Vista de una ubicación para su dueño: sin rutas de Storage ni URL firmadas. */
export interface LocationView {
  id: string
  name: string
  kind: LocationKind
  parentId: string | null
  version: string
  /** Foto general del mueble o de referencia (asset propio listo); la ruta de lectura autenticada se deriva del ID. */
  photoAssetId: string | null
  /** Ejemplares situados directamente en esta ubicación. */
  copies: number
  /** Ubicaciones que contiene directamente. */
  children: number
}

export interface LocationTreeEntry extends LocationView {
  /** Nivel en el árbol: 1 en la raíz. */
  depth: number
  /** Nombres desde la raíz hasta esta ubicación, ambas incluidas. */
  path: string[]
}

/** Ubicación actual de un ejemplar, con su ruta legible. */
export interface CopyLocationView {
  locationId: string
  shelfLabel: string | null
  position: number | null
  version: string
  path: string[]
  kind: LocationKind
}

/** Qué hacer con el contenido al borrar una ubicación ocupada: rechazar (por defecto) o pasarlo a la ubicación que la contiene. */
export const DELETE_CONTENTS = ["reject", "move-to-parent"] as const
export type DeleteContents = (typeof DELETE_CONTENTS)[number]

export const LOCATION_CONTENTS_PAGE_SIZE = 50

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
const length = (value: string) => [...value].length

function invalid(message: string): never {
  throw new DomainError("INVALID_INPUT", message)
}

/** Nombre de una ubicación: 1–120 caracteres sin espacios en los extremos (se recortan) ni caracteres de control. */
export function parseLocationName(input: unknown): string {
  const name = typeof input === "string" ? input.trim() : ""
  if (!name) invalid("Escribe un nombre para la ubicación.")
  if (length(name) > LOCATION_LIMITS.nameMax) invalid(`El nombre admite como máximo ${LOCATION_LIMITS.nameMax} caracteres.`)
  if (CONTROL.test(name)) invalid("El nombre contiene caracteres no admitidos.")
  return name
}

export function parseLocationKind(input: unknown): LocationKind {
  if (typeof input === "string" && (LOCATION_KINDS as readonly string[]).includes(input)) return input as LocationKind
  return invalid("Elige un tipo de ubicación válido.")
}

/** Balda o hueco legible del ejemplar («Balda 3»): vacío equivale a sin etiqueta; 1–60 caracteres. */
export function parseShelfLabel(input: unknown): string | null {
  if (input === null || input === undefined) return null
  if (typeof input !== "string") invalid("La balda o hueco no es válida.")
  const label = input.trim()
  if (!label) return null
  if (length(label) > LOCATION_LIMITS.shelfLabelMax) invalid(`La balda o hueco admite como máximo ${LOCATION_LIMITS.shelfLabelMax} caracteres.`)
  if (CONTROL.test(label)) invalid("La balda o hueco contiene caracteres no admitidos.")
  return label
}

/** Posición manual: entero 1–100000, o sin posición. Nadie la renumera: dos ejemplares pueden compartirla. */
export function parsePosition(input: unknown): number | null {
  if (input === null || input === undefined || input === "") return null
  const value = typeof input === "string" && /^\d+$/.test(input.trim()) ? Number(input.trim()) : input
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > LOCATION_LIMITS.positionMax) {
    invalid(`La posición debe ser un número entero entre 1 y ${LOCATION_LIMITS.positionMax.toLocaleString("es-ES")}.`)
  }
  return value
}

export const locationIdSchema = z.uuid({ message: "La ubicación no es válida." })
export const locationVersionSchema = z.guid({ message: "La versión de la ubicación no es válida." })

/** Nombres desde la raíz hasta `id`. Un árbol dañado (ciclo) se corta en el límite de niveles en lugar de colgarse. */
export function locationPath(byId: ReadonlyMap<string, Pick<LocationView, "name" | "parentId">>, id: string): string[] {
  const names: string[] = []
  let cursor: string | null = id
  const seen = new Set<string>()
  while (cursor && !seen.has(cursor) && names.length < LOCATION_LIMITS.maxDepth) {
    seen.add(cursor)
    const entry = byId.get(cursor)
    if (!entry) break
    names.unshift(entry.name)
    cursor = entry.parentId
  }
  return names
}

/** Ruta legible: «Salón › Estantería grande › Balda 3 · hueco «Fila de atrás» · posición 4». */
export function formatLocationPath(path: readonly string[], details: { shelfLabel?: string | null; position?: number | null } = {}): string {
  const parts = [path.join(" › ")]
  if (details.shelfLabel) parts.push(`hueco «${details.shelfLabel}»`)
  if (details.position) parts.push(`posición ${details.position}`)
  return parts.filter(Boolean).join(" · ")
}

const collator = new Intl.Collator("es", { sensitivity: "base", numeric: true })

/** Árbol en orden de lectura (cada ubicación seguida de las que contiene, hermanas por nombre), con nivel y ruta. */
export function buildLocationTree(locations: readonly LocationView[]): LocationTreeEntry[] {
  const byId = new Map(locations.map((location) => [location.id, location]))
  const children = new Map<string | null, LocationView[]>()
  for (const location of locations) {
    // Una madre que no llega (no debería ocurrir) deja la ubicación en la raíz en lugar de esconderla.
    const parent = location.parentId && byId.has(location.parentId) ? location.parentId : null
    children.set(parent, [...(children.get(parent) ?? []), location])
  }
  for (const list of children.values()) list.sort((a, b) => collator.compare(a.name, b.name) || a.id.localeCompare(b.id))
  const ordered: LocationTreeEntry[] = []
  const visit = (parent: string | null, depth: number, path: string[], seen: Set<string>) => {
    for (const location of children.get(parent) ?? []) {
      if (seen.has(location.id)) continue
      seen.add(location.id)
      const entryPath = [...path, location.name]
      ordered.push({ ...location, depth, path: entryPath })
      visit(location.id, depth + 1, entryPath, seen)
    }
  }
  visit(null, 1, [], new Set())
  return ordered
}

/** IDs de la ubicación y de todas las que contiene. */
export function subtreeIds(locations: readonly Pick<LocationView, "id" | "parentId">[], id: string): Set<string> {
  const result = new Set([id])
  let grew = true
  while (grew) {
    grew = false
    for (const location of locations) {
      if (location.parentId && result.has(location.parentId) && !result.has(location.id)) { result.add(location.id); grew = true }
    }
  }
  return result
}

/** Niveles por debajo de la ubicación (0 si no contiene ninguna). */
export function subtreeHeight(locations: readonly Pick<LocationView, "id" | "parentId">[], id: string): number {
  const kids = locations.filter((location) => location.parentId === id)
  return kids.length ? 1 + Math.max(...kids.map((kid) => subtreeHeight(locations, kid.id))) : 0
}

/**
 * Destinos válidos al mover `id` (pista para la interfaz; la base vuelve a comprobarlo con BL001/BL002): ni ella misma
 * ni una de sus interiores, y sin superar los 8 niveles con todo lo que contiene.
 */
export function moveTargets(tree: readonly LocationTreeEntry[], id: string): LocationTreeEntry[] {
  const excluded = subtreeIds(tree, id)
  const height = subtreeHeight(tree, id)
  return tree.filter((entry) => !excluded.has(entry.id) && entry.depth + 1 + height <= LOCATION_LIMITS.maxDepth)
}

export function locationKindLabel(kind: LocationKind): string {
  return LOCATION_KIND_LABELS[kind]
}

/** Ruta autenticada del propio origen para la foto de una ubicación; `v` cambia al sustituirla. */
export function locationPhotoUrl(location: Pick<LocationView, "id" | "photoAssetId">): string | null {
  return location.photoAssetId ? `/api/locations/${location.id}/photo?v=${location.photoAssetId}` : null
}
