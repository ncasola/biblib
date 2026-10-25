import { z } from "zod"
import { canonicalSeriesPosition, SERIES_LIMITS } from "./product/contracts"

// Series y orden de volúmenes (U-PRO-05). Tipos y validación compartidos por las acciones (app/actions/series.ts) y las
// pantallas. La posición viaja siempre como texto decimal exacto (`SERIES_POSITION_PATTERN`): nunca un número de JS.

export const SERIES_POSITION_HINT = "Usa un número sin ceros a la izquierda y hasta 4 decimales, como 1, 1.5 o 12."

/** Serie privada con el número de volúmenes vinculados. */
export interface SeriesSummary {
  id: string
  title: string
  description?: string
  version: string
  volumes: number
}

/** Volumen de una serie: la edición vinculada con su posición y el ejemplar que abre la ficha. */
export interface SeriesVolume {
  editionId: string
  /** Ejemplar más antiguo de la edición: destino del enlace a la ficha. */
  bookId: string
  copies: number
  title: string
  subtitle?: string
  authors: string[]
  cover: string
  /** Posición exacta; ausente si el orden es desconocido (nunca se infiere de la fecha de publicación). */
  position?: string
  volumeLabel?: string
  orderNote?: string
  /** Token del vínculo: protege mover y quitar el volumen. */
  version: string
}

export interface SeriesDetail extends SeriesSummary {
  items: SeriesVolume[]
}

/** Vínculo de una edición con su serie, tal como lo muestra la ficha. */
export interface EditionSeriesLink {
  series: { id: string; title: string }
  position?: string
  volumeLabel?: string
  orderNote?: string
  version: string
}

/** Lo que necesita la sección «Serie» de la ficha: el vínculo actual (si hay) y las series de la cuenta. */
export interface EditionSeriesState {
  link: EditionSeriesLink | null
  available: Array<{ id: string; title: string }>
}

export type PositionInput = { ok: true; value: string | null } | { ok: false; message: string }

/**
 * Posición escrita por la persona: vacía = orden desconocido (`null`); admite la coma decimal; «1.50» se guarda como
 * «1.5». Rechaza ceros a la izquierda, negativos, notación científica, miles y texto.
 */
export function parseSeriesPositionInput(raw: string | null | undefined): PositionInput {
  const text = (raw ?? "").trim().replace(",", ".")
  if (!text) return { ok: true, value: null }
  const canonical = canonicalSeriesPosition(text)
  return canonical === null ? { ok: false, message: SERIES_POSITION_HINT } : { ok: true, value: canonical }
}

const text = (max: number, message: string) => z.string().trim().min(1, message).max(max, message)
/** Texto opcional: vacío o `null` guardan «sin valor». */
const optionalText = (max: number, message: string) =>
  z.union([z.string(), z.null()]).optional().transform((value) => (value ?? "").trim() || null)
    .refine((value) => value === null || [...value].length <= max, message)

export const seriesTitleSchema = text(SERIES_LIMITS.titleMax, `El título de la serie debe tener entre 1 y ${SERIES_LIMITS.titleMax} caracteres.`)
const seriesDescriptionSchema = optionalText(SERIES_LIMITS.descriptionMax, `La descripción admite hasta ${SERIES_LIMITS.descriptionMax} caracteres.`)
const positionSchema = z.union([z.string(), z.null()]).optional().transform((value, ctx) => {
  const parsed = parseSeriesPositionInput(value)
  if (!parsed.ok) { ctx.addIssue({ code: "custom", message: parsed.message }); return z.NEVER }
  return parsed.value
})
const uuid = z.uuid({ message: "El identificador no es válido." })
const version = z.guid({ message: "La versión no es válida." })

export const createSeriesSchema = z.strictObject({ title: seriesTitleSchema, description: seriesDescriptionSchema })
export const updateSeriesSchema = z.strictObject({ id: uuid, expectedVersion: version, title: seriesTitleSchema, description: seriesDescriptionSchema })
export const deleteSeriesSchema = z.strictObject({ id: uuid, expectedVersion: version })
export const seriesIdSchema = uuid

const volumeFields = {
  position: positionSchema,
  volumeLabel: optionalText(SERIES_LIMITS.volumeLabelMax, `La etiqueta del volumen admite hasta ${SERIES_LIMITS.volumeLabelMax} caracteres.`),
  orderNote: optionalText(SERIES_LIMITS.orderNoteMax, `La nota de orden admite hasta ${SERIES_LIMITS.orderNoteMax} caracteres.`),
}
export const linkEditionSchema = z.strictObject({ editionId: uuid, seriesId: uuid, ...volumeFields })
/** Mover = cambiar posición, etiqueta, nota o serie de un vínculo existente, con su versión. */
export const moveVolumeSchema = z.strictObject({ editionId: uuid, seriesId: uuid, expectedVersion: version, ...volumeFields })
export const unlinkEditionSchema = z.strictObject({ editionId: uuid, expectedVersion: version })

/** Texto visible de una posición: un orden desconocido se muestra como tal, nunca se infiere de la fecha. */
export function describePosition(position: string | undefined): string {
  return position === undefined ? "Orden desconocido" : position
}
