/**
 * Seudónimo estable de cuenta para telemetría (U-OPS-01).
 *
 * HMAC-SHA256 del ID de usuario con el secreto de servidor
 * `BIBLIB_TELEMETRY_SALT`. Si el secreto no está configurado, el campo se omite
 * por completo: nunca se registra el ID en claro. Sin `import "server-only"`
 * por la misma razón que `correlation.ts`: las pruebas lo ejercitan con
 * `node --test`. La aplicación lo recibe desde el límite `server.ts`.
 */
import { createHmac } from "node:crypto"

export function accountRef(userId: string): string | undefined {
  const salt = process.env.BIBLIB_TELEMETRY_SALT
  if (!salt?.trim()) return undefined
  if (typeof userId !== "string" || userId.length === 0 || userId.length > 200) return undefined
  return `acct_${createHmac("sha256", salt).update(userId).digest("hex")}`
}
