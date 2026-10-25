// U-OPS-03 · Contratos de la eliminación de cuenta que comparten la acción y la interfaz. El worker administrativo
// (lib/account-deletion/worker.ts) define los pasos y el inventario; aquí solo lo que ve la persona.

/** Frase que la persona escribe para confirmar; la acción la compara en el servidor. */
export const DELETION_CONFIRMATION = "ELIMINAR MI CUENTA"

/** Clave de operación generada por la interfaz para cada confirmación (reintento y doble clic). */
export const OPERATION_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/

/** Inicio de sesión reciente: la eliminación exige haber entrado hace como mucho 15 minutos. */
export const RECENT_SIGN_IN_MS = 15 * 60_000

/** Momento del último inicio de sesión según el claim `amr` verificado de GoTrue (segundos → ms); null si no consta. */
export function lastSignInAt(amr: unknown): number | null {
  if (!Array.isArray(amr)) return null
  const timestamps = amr.map((entry: unknown) => entry && typeof entry === "object" && "timestamp" in entry && typeof entry.timestamp === "number" ? entry.timestamp * 1000 : null)
    .filter((value): value is number => value !== null)
  return timestamps.length ? Math.max(...timestamps) : null
}

/** Inicio de sesión de hace como mucho `RECENT_SIGN_IN_MS`; un instante futuro (reloj manipulado) no cuenta. */
export function isRecentSignIn(amr: unknown, now: number): boolean {
  const at = lastSignInAt(amr)
  return at !== null && now - at <= RECENT_SIGN_IN_MS && at <= now + 60_000
}

/** Plazo máximo de las copias administrativas antes de expirar (docs/retencion.md). */
export const ADMIN_BACKUP_RETENTION_DAYS = 35

/** Lo que la persona ve de su solicitud: nunca códigos técnicos, contadores ni datos de otras cuentas. */
export type AccountDeletionPhase = "none" | "requested" | "in_progress" | "retrying" | "needs_attention" | "completed"

export interface AccountDeletionView {
  phase: AccountDeletionPhase
  requestedAt: string | null
  /** Solo en la respuesta de la solicitud: si GoTrue cerró ya todas las sesiones de la cuenta. */
  sessionsRevoked?: boolean
}

/** Estado interno de `biblib.account_deletions` → fase visible. */
export function deletionPhase(state: string, step?: string): AccountDeletionPhase {
  if (state === "pending") return step === "sessions" ? "requested" : "in_progress"
  if (state === "running") return "in_progress"
  if (state === "waiting_retry") return "retrying"
  if (state === "failed") return "needs_attention"
  if (state === "completed") return "completed"
  return "none"
}

/** Respuesta de `account_deletion_request`/`account_deletion_status` → vista, sin campos internos. */
export function toDeletionView(raw: unknown): AccountDeletionView {
  const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {}
  const state = typeof value.state === "string" ? value.state : "none"
  const requestedAt = typeof value.requestedAt === "string" ? new Date(value.requestedAt).toISOString() : null
  return { phase: deletionPhase(state, typeof value.step === "string" ? value.step : undefined), requestedAt: state === "none" ? null : requestedAt }
}

export const DELETION_PHASE_TEXT: Readonly<Record<AccountDeletionPhase, string>> = {
  none: "No hay ninguna solicitud de eliminación.",
  requested: "Solicitud registrada. Tu cuenta ya no admite cambios y la eliminación empezará en breve.",
  in_progress: "Eliminando tus datos. Tu cuenta ya no admite cambios.",
  retrying: "La eliminación se ha retrasado por un fallo temporal y se reintentará automáticamente. Tu cuenta sigue sin admitir cambios.",
  needs_attention: "La eliminación necesita una revisión del equipo de operación, que la reanudará. Tu cuenta sigue sin admitir cambios.",
  completed: "Tu cuenta se ha eliminado.",
}

/** Alcance que explica la interfaz antes de confirmar; se mantiene alineado con docs/retencion.md. */
export const DELETION_SCOPE: readonly string[] = [
  "Tus libros: ejemplares, ediciones y obras, con su estado, estantería y comprobaciones.",
  "Tus estanterías, incluida la predeterminada, y tus vistas guardadas.",
  "Tus notas, valoraciones y etiquetas, tus ubicaciones físicas y series, y la revisión bibliográfica con sus evidencias.",
  "Tu historial de lectura (lecturas, relecturas y sesiones) y tus préstamos, con los alias de quienes tienen tus libros.",
  "Tu foto de perfil propia, las fotos de tus ubicaciones y evidencias, y tus perfiles de importación CSV.",
  "Las portadas privadas que subiste o copiaste y sus imágenes.",
  "Las versiones anteriores de tu biblioteca, las importaciones y restauraciones en curso y sus trabajos.",
  "La caché privada de tus búsquedas por título o autor.",
  "Al final, tu acceso a BibLib (la identidad vinculada a tu cuenta de Google).",
]
