import type { Book } from "@/lib/types"

interface BookStatusBadgeProps {
  status: Book["status"]
}

const STATUS_LABELS: Record<Book["status"], string> = {
  read: "Leído",
  reading: "Leyendo",
  "to-read": "Por leer",
  unread: "Sin empezar",
}

/** Chip de estado de lectura con los colores de estado del sistema visual (`.status-chip`, contraste AA). */
export function BookStatusBadge({ status }: BookStatusBadgeProps) {
  const known = status in STATUS_LABELS ? status : "unread"
  return <span data-slot="badge" data-status={known} className="status-chip">{STATUS_LABELS[known]}</span>
}
