# U-OPS-01 · Evidencia de primitivas F0

Fecha: 23-10-2026. Rama: `u-ops-01`, worktree hijo de `feature/spec-pendientes`. Implementación: `c6f98f10adf00534ed4c69c16fd9b1326d32a478`. Hallazgos relacionados: OPS-01, BE-01. Se revisó y completó el trabajo parcial del intento anterior.

## Entrega

Catálogo cerrado de 14 eventos, lista blanca de 11 campos, logger JSON stdout/stderr con contador local de descartes, saneado de valores, desactivación explícita y por variable, correlación Node con aislamiento concurrente y cabeceras validadas, HMAC opcional de cuentas y clasificación de fallos del proveedor. El límite de aplicación `server.ts` declara `server-only`; los módulos compartidos con cliente solo reciben un emisor opcional sin dependencias Node. Los puntos F0 no registran IDs de cuenta.

Instrumentación mínima en Auth, validación/commit/conflicto de importación, Open Library y recuperación de portadas por lote e individual. La búsqueda HTTP devuelve `x-correlation-id`; los errores conservan sus respuestas de dominio. No se cambiaron persistencia, límites, caché, reintentos ni reglas de recuperación/CAS.

## Comandos y resultados reales

| Comando / entorno | Resultado |
| --- | --- |
| `pnpm lint` | Código 0. |
| `pnpm typecheck` | Código 0; tipos de rutas generados y TypeScript correcto. |
| `pnpm test` | Código 0, 66/66: 50 existentes y 16 nuevas de observabilidad. |
| `BIBLIB_TELEMETRY=off` + `pnpm test` | Código 0, 66/66; los grupos del logger configuran su estado de prueba y lo restauran, el catálogo existente se ejecuta con `off`. |
| `pnpm test:scripts` | Código 0, 24/24 en 5 suites, sin Docker. |
| `pnpm build --webpack` | Código 0 en copia temporal del código, excluyendo todos los archivos `.env*`, con dependencia local enlazada y URL/clave pública/DSN ficticios de loopback. 14 páginas generadas, rutas dinámicas y proxy compilados. No se ejecutó el build Turbopack por defecto. |
| `git diff --check` | Sin errores de espacios. |

Entorno: Windows/PowerShell, Next.js 16.4.2, herramientas pnpm del repositorio. Las consultas a proveedor se simulan; no se usaron archivos de entorno, secretos reales, base remota ni stack Docker. La copia temporal de build no forma parte de la entrega ni contiene archivos de entorno del checkout.

La primera ejecución de las pruebas nuevas detectó una clave con formato compatible con el campo de correlación: se corrigió la validación/saneado y la ejecución posterior quedó en verde. El test `Open Library 429/404/503 produce un evento correlacionado sin ISBN ni título` simula esas tres respuestas, verifica `rate_limited` / `not_found` / `upstream_error`, códigos de dominio conservados y correlación por operación, y comprueba ausencia de ISBN, título, autor y URL en la serialización completa del sink.

También se verifica que un timeout al leer un cuerpo HTTP 200 no se convierta en error de estado, que un sink/emisor defectuoso no altere resultados ni excepciones, y que las portadas con fallo 429 mantengan el fallback. Las pruebas de anidación restauran el contexto tras excepciones y las concurrentes usan ocho operaciones con esperas intercaladas. HMAC se prueba con sales sintéticas distintas y ausencia de sal.

## Límites y pendientes

- La revisión visual del archivo existe solo en el cliente. `import.preview` representa la validación equivalente que ya ejecuta el servidor al confirmar; no se añadió endpoint ni refactor de la revisión. No se mide abandono de previews.
- No existe exportador, panel remoto, almacenamiento de logs ni evaluador/notificación de alertas. [Alertas](../../../alertas.md) propone métricas, umbrales, ventanas, responsable Néstor, acciones, deduplicación y disparos sintéticos. Retención propuesta: 14 días de logs / 90 días de agregados sin cuenta ni correlación, pendiente de implantar en alojamiento.
- Jobs/proveedores nuevos se instrumentarán en F1. Los eventos de DB/Storage/cuentas/migraciones quedan disponibles como primitivas; no se instrumentan wrappers, schema ni servicios aún no implementados por esta unidad. Las comprobaciones OAuth/cookies reales y el disparo remoto siguen pendientes de sus unidades.
- No hubo prueba manual de navegador ni integración real de Auth/DB; no cambia UI ni datos persistidos. La correlación HTTP se conecta en la ruta y compila; el fallo inducido de proveedor se demuestra con una prueba unitaria y sink en memoria.
- No se tocaron `scripts/`, `supabase/`, `drizzle*`, `lib/db/schema.ts`, `package.json`, lockfile, `next.config.mjs` ni `drizzle.config.ts`. Sin migraciones, push o PR; sin conflictos conocidos con U-INF-02.

## Recuperación y compatibilidad

`BIBLIB_TELEMETRY=off` desactiva incluso loggers ya creados; también existe `createLogger({ enabled:false })`. No hay estado de dominio que recuperar ni migración inversa. Las funciones compartidas mantienen firmas anteriores mediante argumentos opcionales; sin emisor usan no-op. Para retirar toda la instrumentación se puede revertir el commit de implementación, conservando la documentación histórica. Los logs nunca se usan para reconstruir trabajos o bibliotecas.
