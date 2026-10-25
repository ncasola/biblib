import { READING_CYCLE_STATUS_LABELS, type ReadingCycleStatus, type ReadingProgress } from "@/lib/product/reading-loans"
import { formatInstant, formatInstantDate, progressText } from "@/lib/reading"

// Piezas de presentación de la lectura (U-PRO-02), comunes a la ficha y al inicio. Las fechas se formatean en la zona
// horaria del navegador de la persona: estos componentes solo se pintan en el cliente, tras cargar los datos.

const CHIP: Record<ReadingCycleStatus, string> = { reading: "reading", paused: "to-read", finished: "read", abandoned: "unread" }

/** Chip del estado de un ciclo (Leyendo, En pausa, Terminado, Abandonado) con los colores de estado del sistema visual. */
export function ReadingCycleBadge({ status }: { status: ReadingCycleStatus }) {
  return <span data-status={CHIP[status]} className="status-chip">{READING_CYCLE_STATUS_LABELS[status]}</span>
}

/** Instante en la zona de la persona; `dateOnly` muestra solo el día. */
export function ReadingTime({ iso, dateOnly = false }: { iso: string; dateOnly?: boolean }) {
  return <time dateTime={iso}>{dateOnly ? formatInstantDate(iso) : formatInstant(iso)}</time>
}

/**
 * Progreso honesto: con total conocido, barra y «Página N de T (P %)»; sin total, solo la página y ninguna barra; sin
 * entradas con página, «Sin progreso registrado».
 */
export function ReadingProgressView({ progress, label }: { progress: ReadingProgress | null; label: string }) {
  const text = progressText(progress)
  return <div className="flex flex-col gap-1.5" data-testid="reading-progress">
    {progress?.percent !== null && progress?.percent !== undefined && (
      <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent} aria-valuetext={text}
        className="h-1.5 overflow-hidden rounded-full bg-foreground/10">
        <div className="h-full rounded-full bg-gradient-to-r from-brass to-brass-light" style={{ width: `${progress.percent}%` }} />
      </div>
    )}
    <span className="text-sm text-foreground-light">{text}</span>
  </div>
}
