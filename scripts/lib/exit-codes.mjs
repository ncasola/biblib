// Códigos de salida estables de los wrappers locales de BibLib.
// Contrato: docs/spec-pendientes/01-entorno-y-migraciones.md («Argumentos y códigos de salida»).

export const EXIT = Object.freeze({
  OK: 0,
  INVALID_ARGS: 2,
  IDENTITY_MISMATCH: 3,
  MISSING_REQUIREMENT: 4,
  HISTORY_DIVERGED: 5,
  PLAN_REJECTED: 6,
  LOCK_BUSY: 7,
  SERVICE_UNAVAILABLE: 8,
  MIGRATION_FAILED: 9,
  SEED_FAILED: 10,
  VERIFICATION_FAILED: 11,
  INTERRUPTED: 130,
})

const DESCRIPTIONS = Object.freeze({
  [EXIT.OK]: "Operación o diagnóstico completado.",
  [EXIT.INVALID_ARGS]: "Argumentos, objetivo o configuración incompletos o malformados.",
  [EXIT.IDENTITY_MISMATCH]: "Identidad o propiedad del destino o del artefacto incorrecta.",
  [EXIT.MISSING_REQUIREMENT]: "Falta un requisito local: CLI, Docker, herramienta o versión.",
  [EXIT.HISTORY_DIVERGED]: "Historial, hash u objetos de la base divergentes; se requiere adopción.",
  [EXIT.PLAN_REJECTED]: "Plan caducado o no coincidente, o falta autorización o recibo.",
  [EXIT.LOCK_BUSY]: "Bloqueo ocupado o concurrencia; reintentar de forma acotada.",
  [EXIT.SERVICE_UNAVAILABLE]: "Conexión o servicio no disponible, o salud fallida.",
  [EXIT.MIGRATION_FAILED]: "Migración fallida, sin éxito ni avance del ledger.",
  [EXIT.SEED_FAILED]: "Seed o bootstrap fallido en una fase de datos de prueba.",
  [EXIT.VERIFICATION_FAILED]: "Verificación posterior fallida.",
  [EXIT.INTERRUPTED]: "Interrupción solicitada.",
})

const VALID_CODES = new Set(Object.values(EXIT))

export function isExitCode(code) {
  return VALID_CODES.has(code)
}

export function describeExit(code) {
  return DESCRIPTIONS[code] ?? "Código de salida desconocido."
}

/**
 * Error de wrapper con código de salida estable y fase en la que ocurrió.
 * El mensaje se muestra al usuario: no debe contener secretos ni URLs con credenciales.
 */
export class BiblibError extends Error {
  /**
   * @param {number} code Uno de los valores de `EXIT` distinto de 0.
   * @param {string} phase Fase del wrapper (por ejemplo, `perfil`, `preflight`, `migración`).
   * @param {string} message Explicación en español, sin secretos.
   * @param {{ cause?: unknown }} [options]
   */
  constructor(code, phase, message, options) {
    if (!isExitCode(code) || code === EXIT.OK) {
      throw new TypeError(`Código de salida no válido para BiblibError: ${String(code)}`)
    }
    if (typeof phase !== "string" || phase.trim() === "") {
      throw new TypeError("BiblibError requiere una fase no vacía.")
    }
    super(message, options)
    this.name = "BiblibError"
    this.code = code
    this.phase = phase
  }

  toJSON() {
    return { code: this.code, phase: this.phase, message: this.message }
  }
}
