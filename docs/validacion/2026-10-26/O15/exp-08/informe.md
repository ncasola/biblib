# Informe O15 · U-EXP-08 · PWA con consulta sin conexión de solo lectura

**Fecha:** 26 de octubre de 2026 · **Ramas:** `u-exp-08` (implementación, sin stack) y `u-exp-08-stack` (worktree `u-qa-01`, con `feature/spec-pendientes` integrada, U-PRO-04 incluida) · **Perfil:** `test` (levantado por el coordinador, no se ha parado) · **Contrato:** [contratos-o15](../../../../spec-pendientes/contratos-o15.md) · **Operación:** [docs/operacion.md → U-EXP-08](../../../../operacion.md#copia-de-lectura-sin-conexión-y-pwa--u-exp-08-o15).

## Qué se entrega

- **PWA:**
  - `public/manifest.webmanifest` con los iconos actuales: `logo-mark.png` (`any`) y `logo.png` (`maskable`).
  - `public/sw.js`: service worker de shell estático, versionado por la URL de registro (`/sw.js?v=…`). Borra las cachés de versiones anteriores y tiene modo de limpieza (`?modo=limpieza` o `FORZAR_LIMPIEZA`).
  - Registro en `components/offline-runtime.tsx` desde `app/layout.tsx`, solo con build de producción.
- **Copia de lectura** `lib/offline-library.ts`:
  - Crear, abrir, renovar, bloquear y borrar la copia; comprobar el TTL; contador de intentos; corrupción y cuota.
  - PBKDF2-HMAC-SHA-256 con 600 000 iteraciones y sal de 16 bytes. AES-KW envuelve una clave AES-GCM de 256 bits, no extraíble al abrir. IV de 12 bytes en cada escritura y AAD por cuenta.
  - Una base IndexedDB por cuenta (hash del id).
- **Bandera** `BIBLIB_OFFLINE_SNAPSHOT=1`, de servidor y apagada por defecto (`lib/offline-config.ts`). Llega al cliente como prop, sin `NEXT_PUBLIC_`. También pasa por `scripts/next-target.mjs` junto a `BIBLIB_SERVICE_WORKER=limpieza`.
- **Acciones** `app/actions/offline-library.ts`, solo de lectura:
  - Proyección con lista blanca de la colección de la sesión.
  - Validación con conexión.
- **Ajuste** en `/settings` («Copia de lectura sin conexión»):
  - Activar con PIN o frase y una confirmación explícita.
  - Ver la fecha, la cuenta enmascarada, la última validación y la caducidad.
  - Renovar con el PIN o quitar la copia.
  - Corrupción y cuota, con mensajes claros.
- **Vista** `/offline`:
  - Indicador «Copia del …», cuenta enmascarada y caducidad.
  - Desbloqueo con los intentos restantes.
  - Consulta de solo lectura con búsqueda y filtro por estantería: estado, «Prestado», ubicación, serie y etiquetas.
  - Bloqueo manual, al caducar y al cambiar de cuenta.
- **Cierre de sesión** (`lib/auth-context.tsx`): se purga la copia de la cuenta antes de cerrar sesión, y también al recibir `SIGNED_OUT`.
- **Cabeceras:** `sw.js` y `/offline` salen con `private, no-store`, con la regla única existente. La matriz `scripts/security/headers-matrix.mjs` añade `/offline` (anónimo y con A) y `/sw.js` (tipo `service-worker`).
- **Documentación:** contrato `contratos-o15.md`, sección en `docs/operacion.md` (activación, recuperación y worker de limpieza) y este informe.

## Puerta G15 (parte de U-EXP-08)

| Criterio | Evidencia |
| --- | --- |
| La copia es opt-in, de solo lectura y por cuenta | E2E «sin consentimiento…»: tras recorrer `/`, `/books`, la ficha y `/settings` no hay base `biblib-offline-*` ni puntero en `localStorage`. E2E «activar con PIN…»: un PIN de 5 dígitos se rechaza sin crear la base; con la confirmación se crea una sola. Sin red no hay botones de guardar, editar, eliminar, añadir, mover, prestar ni devolver. Capturas `offline-copia-*.png`. |
| Muestra su antigüedad, se desbloquea y se bloquea al expirar | Título «Copia del …», cuenta `l•••@b•••.test` y «caduca el …» (capturas `offline-bloqueada-*`, `offline-copia-*`). Un PIN erróneo avisa «Te quedan 9 intentos». E2E «un TTL vencido…»: con reloj simulado a +8 días aparece «Copia bloqueada por caducidad», sin formulario y sin borrar la base; al validar con conexión se vuelve a abrir. Unitarias: TTL justo en el límite, vencido, reloj atrasado y 10 intentos con borrado. |
| Los datos de la cuenta A nunca aparecen en la sesión de B | E2E «A y B en el mismo navegador…»: con la sesión de B, `/offline` no muestra la copia de A (ni títulos ni cuenta). Con dos bases, el PIN de A no abre la de B ni la frase de B la de A, y cada una muestra solo sus libros. Unitarias: base y clave por cuenta; una base copiada sobre otra cuenta se rechaza (meta y AAD). |
| El cierre de sesión y la reconexión purgan según el contrato | E2E «el cierre de sesión…»: tras cerrar sesión desde el menú no queda la base de A ni el puntero. La reconexión con sesión valida y reabre (E2E del TTL); la de otra cuenta bloquea la vista anterior (E2E A/B). |
| El worker no cachea rutas autenticadas, acciones ni `/api` | Unitarias del worker (`tests/offline-service-worker.test.ts`): solo `/_next/static`, iconos, manifiesto y `/offline`. Nunca acciones, RSC, `/api`, `/auth`, `/_next/image` ni imágenes remotas; una navegación con red no se guarda. E2E: todas las entradas de Cache Storage son estáticas y el `/offline` guardado no contiene el correo, el id, el nombre ni los títulos de A. |
| Sin consentimiento solo hay shell estático | Mismo E2E: una única caché `biblib-shell-<versión>` con estáticos y `/offline`, sin IndexedDB de copia. |

Aceptación de 03:
- Sin consentimiento no hay copia privada.
- El PIN o la frase abren solo la copia de esa cuenta en ese dispositivo.
- Sin conexión solo se lee hasta el TTL; al vencer, se bloquea hasta autenticarse con conexión, sin borrar.
- El cierre de sesión con conexión borra la copia y su clave.
- Los textos no prometen revocación remota ni protección frente a XSS.
- No hay acciones pendientes de sincronizar.
- Una copia dañada ofrece borrarla y descargarla de nuevo (unitarias de corrupción y botones en Ajustes y `/offline`).

Pruebas locales de 03:
- Probados: dos cuentas, cierre de sesión, expiración, renovación, desconexión durante la navegación (una navegación sin red lleva a `/offline`), cuota (unitaria), actualización del worker y borrado de los datos del sitio.

## Ejecuciones

| Comando | Dónde | Resultado |
| --- | --- | --- |
| `pnpm lint` | `u-exp-08-stack` | ✔ ([lint.log](lint.log)) |
| `pnpm typecheck` | `u-exp-08-stack` | ✔ ([typecheck.log](typecheck.log)) |
| `pnpm test` | `u-exp-08-stack` | ✔ 516/516 ([test.log](test.log)); de U-EXP-08, 16 de `offline-library` y 6 del worker |
| `pnpm test:scripts` | `u-exp-08-stack` | ✔ 273 superadas y 2 omitidas por diseño ([test-scripts.log](test-scripts.log)), incluida `offline-env.test.mjs` |
| `pnpm build` | `u-exp-08-stack` | ✔, `/offline` dinámica ([build.log](build.log)) |
| `pnpm test:smoke` | `u-exp-08-stack` | ✔ 12 comprobaciones, contenedor efímero borrado ([test-smoke.log](test-smoke.log)) |
| `pnpm test:e2e:local --profile test --grep "offline:"` | perfil `test` | 1.ª ejecución: 7 fallos (bandera filtrada, hallazgo 1). 2.ª: 2 fallos (avisos, hallazgo 2). 3.ª: 1 fallo (hallazgo 3). La versión final de los 7 recorridos pasa en la suite completa (fila siguiente). |
| `pnpm test:e2e:local --profile test` (Chromium completo) | perfil `test` | ✔ 81 superados, 17 pendientes (fixme), 0 fallidos, 0 repeticiones, sin salidas de red del servidor ([e2e-chromium-completo.log](e2e-chromium-completo.log)) |
| `pnpm test:integration:security --profile test` | perfil `test` | ✔ 24/24 ([integration-security.log](integration-security.log)) |
| `pnpm security:headers:local --profile test --reuse-build` | perfil `test` | ✔ 53/53 respuestas según la matriz, incluidas `/offline` y `/sw.js` ([headers-local.log](headers-local.log), [headers-test.json](headers-test.json)) |
| `pnpm test:a11y:local --profile test` | perfil `test` | ✔ 10/10 ([a11y.log](a11y.log)) |

### Hallazgos durante el turno de stack (corregidos)

1. **La bandera no llegaba a la app.** `scripts/next-target.mjs` filtra las `BIBLIB_*` heredadas y solo deja pasar una lista blanca. Se añadieron `BIBLIB_OFFLINE_SNAPSHOT` (`1`) y `BIBLIB_SERVICE_WORKER` (`limpieza`), con la prueba `tests/scripts/offline-env.test.mjs`. Afecta también a `start:local`/`dev:local` fuera del E2E.
2. **Avisos en el E2E:** `getByRole("alert")` también encontraba el anunciador de rutas de Next. Se usa `alerts()` de los fixtures.
3. **Actualización del worker:** en una de las ejecuciones, la versión publicada tardó más de 10 s en activarse tras recargar (descarga `/offline` y sus estáticos al instalarse) y la prueba vio las dos cachés a la vez. Pasó en dos ejecuciones aisladas posteriores, todavía con la espera antigua. Ahora la prueba espera al worker activo de esa versión, con un margen de 30 s, y con ese cambio pasó en la suite completa.

## Capturas (Chromium, datos ficticios del censo)

| Pantalla | Claro | Oscuro |
| --- | --- | --- |
| Ajuste con la copia guardada | [offline-ajuste-claro.png](offline-ajuste-claro.png) | [offline-ajuste-oscuro.png](offline-ajuste-oscuro.png) |
| `/offline` bloqueada (pide el PIN) | [offline-bloqueada-claro.png](offline-bloqueada-claro.png) | [offline-bloqueada-oscuro.png](offline-bloqueada-oscuro.png) |
| `/offline` abierta, solo lectura | [offline-copia-claro.png](offline-copia-claro.png) | [offline-copia-oscuro.png](offline-copia-oscuro.png) |

## Decisiones y desviaciones

- **El cierre de sesión en el E2E simula la respuesta de GoTrue** (`/auth/v1/logout` → 204) para no revocar las sesiones guardadas de A, que usan los demás recorridos. La purga es local y se comprueba entera. La revocación real del cierre ya la cubre `cierre/acceso-sesion.spec.ts`, que sigue en verde.
- **La validación con conexión** reinicia el TTL cuando una página de BibLib carga con conexión y la sesión de esa cuenta, confirmada en el servidor. Ocurre como mucho cada 10 minutos y siempre al abrir Ajustes. No cambia los datos de la copia: «Renovar copia» los actualiza con el PIN.
- **`SIGNED_OUT` también purga** (otra pestaña, o sesión revocada o vencida al reconectar). Es la interpretación conservadora de «la reconexión purga según el contrato».
- **Evidencias ajenas:** `test:a11y:local` reescribe las evidencias de O11/exp-03 y O14/pro-04. Se restauraron sin commitearlas: los resultados de esta ejecución están en [a11y.log](a11y.log).
- **El puntero** `biblib-offline-cuenta` (identificador opaco) solo existe si la cuenta tiene copia.
- **Archivos fuera del scope estricto**, cada uno con un cambio mínimo y aditivo en su propio commit:
  - `scripts/security/headers-matrix.mjs`: su prueba exige inventariar cada ruta nueva.
  - `scripts/next-target.mjs`: lista blanca de banderas.
  - `tests/e2e/run.mjs`: activa la bandera en el E2E.
  - `tests/e2e/flujos/pendientes.spec.ts`: se retira el `fixme` de U-EXP-08.

## No probado (pendiente)

- **Firefox y WebKit:** solo se ejecutó Chromium. El borrado de datos del sitio usa CDP (solo Chromium), y `indexedDB.databases()` requiere Firefox 126 o posterior; sin esa API, la limpieza total del worker no puede listar las bases, aunque la purga por cuenta sí funciona.
- **Dispositivos reales**, instalación como PWA (iOS/Android) y modo avión real: solo `context.setOffline` de Playwright.
- **Cuota agotada real del navegador:** solo la unitaria con `QuotaExceededError` inyectado.
- **Rendimiento de PBKDF2** con 600 000 iteraciones en móviles lentos: no medido.
- **Revocación remota con el dispositivo desconectado:** fuera de alcance por diseño; el contrato no la promete.
- **Purga por `SIGNED_OUT` al reconectar con una sesión revocada:** no tiene E2E, porque revocaría las sesiones compartidas del run.
- **Worker de limpieza en un navegador real** (`BIBLIB_SERVICE_WORKER=limpieza` o `FORZAR_LIMPIEZA`): cubierto solo por las unitarias del worker.

## Recursos Docker

No he creado ni parado ningún perfil. El perfil `test` sigue levantado (es del coordinador). El contenedor efímero de `test:smoke` (`biblib-smoke-*`) se borró solo: `docker ps -a --filter name=biblib-smoke` no devuelve nada. No he tocado recursos de HolaERP ni de `scratch`.
