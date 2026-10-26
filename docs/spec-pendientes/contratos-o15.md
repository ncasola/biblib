# Contratos de O15 · copia de lectura sin conexión (U-EXP-08)

**Fecha:** 26 de octubre de 2026 · **Unidad:** U-EXP-08 · **Estado:** implementado en la rama `u-exp-08`, detrás de una bandera apagada por defecto. Las decisiones las fijó el coordinador y el usuario puede revisarlas antes de activar la bandera. Evidencia: [validación O15/exp-08](../validacion/2026-10-26/O15/exp-08/informe.md).

Este documento fija qué guarda BibLib en un dispositivo para consultarlo sin conexión, cómo lo protege, cuándo se bloquea y cuándo se borra. La especificación de producto está en [03 → U-EXP-08](03-experiencia-y-funciones.md#u-exp-08--pwa-con-consulta-offline-de-solo-lectura); la puerta, en [05 → O15](05-fases-olas-y-trazabilidad.md#o15--impresión-y-consulta-offline-explícita). Ningún cambio de este contrato necesita migración: no hay tablas nuevas y nada se sincroniza con Supabase.

| Módulo | Contenido |
| --- | --- |
| [`lib/offline-library.ts`](../../lib/offline-library.ts) | Constantes (TTL, KDF, intentos, límites), proyección con lista blanca (`buildOfflineSnapshot`), validación del secreto, cifrado, almacenamiento por cuenta y errores. Sin `server-only`: lo usan el navegador y el servidor. |
| [`lib/offline-config.ts`](../../lib/offline-config.ts) | Banderas de servidor (`BIBLIB_OFFLINE_SNAPSHOT`, `BIBLIB_SERVICE_WORKER`) y versión del worker (`SERVICE_WORKER_VERSION`). |
| [`app/actions/offline-library.ts`](../../app/actions/offline-library.ts) | `getOfflineSnapshotAction()` (proyección de la colección de la sesión) y `confirmOfflineSessionAction()` (validación con conexión). Solo lectura. |
| [`public/sw.js`](../../public/sw.js) | Service worker de shell estático, versionado, con modo de limpieza. |
| [`components/offline-runtime.tsx`](../../components/offline-runtime.tsx) | Registro del worker y validación al reconectar. |
| [`components/offline-copy-settings.tsx`](../../components/offline-copy-settings.tsx), [`components/offline-library-view.tsx`](../../components/offline-library-view.tsx), [`app/offline/page.tsx`](../../app/offline/page.tsx) | Ajuste en `/settings` y vista sin conexión `/offline`. |

## 1. Banderas y worker

- **Copia de lectura:** `BIBLIB_OFFLINE_SNAPSHOT=1` (servidor), **apagada por defecto**. Se lee en tiempo de ejecución y llega al cliente como prop desde `app/layout.tsx` y `app/offline/page.tsx`; no hay variables `NEXT_PUBLIC_`. Apagada: no aparece el ajuste, las dos acciones responden `NOT_FOUND` y la vista sin conexión no abre copias.
- **Manifiesto y worker:** siempre activos en el build de producción (en `next dev` no se registran). El manifiesto usa los iconos actuales: `logo-mark.png` (`any`) y `logo.png` (`maskable`).
- **Qué guarda el worker:** solo `/_next/static/*` (scripts, estilos y fuentes con hash), los iconos y el manifiesto de `public/`, y la página propia `/offline`, pedida **sin cookies**. Nunca guarda HTML de otras rutas, cargas RSC (`RSC`, `_rsc`), Server Actions (`Next-Action`), `/api`, `/auth/*` (callback OAuth) ni imágenes, ni locales ni remotas.
- **Sin red:** una navegación que falla redirige a `/offline`, servida desde la caché. Con red, las navegaciones van siempre a la red y su respuesta no se guarda.
- **Versión:** el script se registra como `/sw.js?v=<SERVICE_WORKER_VERSION>`. Cambiar la versión instala un worker nuevo, que borra al activarse las cachés `biblib-shell-*` de las versiones anteriores. Las entradas de `/_next/static` se limitan a 400 por caché.
- **Limpieza:** `BIBLIB_SERVICE_WORKER=limpieza` registra `/sw.js?…&modo=limpieza`, que no intercepta nada, borra todas las cachés del origen y las bases `biblib-offline-*` y se da de baja. Si no hay worker instalado, la página limpia lo mismo directamente. Publicar `public/sw.js` con `FORZAR_LIMPIEZA = true` convierte en limpieza cualquier worker instalado en su siguiente comprobación, aunque la página no cargue.

## 2. Secreto local y cifrado

| Elemento | Valor |
| --- | --- |
| Secreto | PIN de **6 dígitos o más**, o frase de **8 caracteres o más** (sin espacios en los extremos), hasta 128. Normalizado a NFC. Nunca se guarda. |
| KDF | **PBKDF2-HMAC-SHA-256** de Web Crypto, **600 000 iteraciones** (`OFFLINE_KDF_ITERATIONS`) y **sal aleatoria de 16 bytes** por copia. Las pruebas reducen las iteraciones solo inyectándolas en `createOfflineLibrary`. |
| Clave derivada | AES-KW de 256 bits, no extraíble, solo `wrapKey`/`unwrapKey`. |
| Clave de datos | AES-GCM de 256 bits aleatoria, envuelta con AES-KW (40 bytes). Solo es extraíble el instante de envolverla; al desenvolverla queda **no extraíble** y vive en memoria mientras la copia está abierta. |
| Cifrado | AES-GCM con **IV aleatorio de 12 bytes en cada escritura** (alta y renovación) y datos adicionales `biblib-offline:1:<cuenta>`, que ligan el contenido a la cuenta. |
| Criptografía propia | Ninguna. |

Se guarda en claro, en la misma base, solo lo necesario para el indicador y para desbloquear: identificador opaco de la cuenta, correo enmascarado, fecha de la copia, última validación, tipo de secreto (PIN o frase), parámetros del KDF, sal, clave envuelta y contador de intentos.

## 3. Intentos, caducidad y recuperación

- **Intentos:** el intento se anota antes de derivar la clave (cerrar la pestaña no lo descuenta) y se reinicia al acertar. **Tras 10 desbloqueos fallidos seguidos se borra la copia de ese dispositivo.** Se puede volver a descargar con conexión. Una clave envuelta alterada no se distingue de un PIN incorrecto y cuenta como intento.
- **TTL:** **7 días desde la última validación con conexión** (`OFFLINE_COPY_TTL_MS`, constante única). Al vencer, la copia queda **bloqueada** hasta autenticarse con conexión; no se borra. Una validación más de 5 minutos en el futuro (reloj atrasado) cuenta como vencida.
- **Validación con conexión:** cuando una página de BibLib carga con conexión y sesión, `confirmOfflineSessionAction` confirma en el servidor qué cuenta tiene la sesión y, si coincide, se reinicia el TTL de **su** copia (como mucho cada 10 minutos, y siempre al abrir Ajustes). No cambia los datos de la copia ni su fecha: para eso está «Renovar copia».
- **Recuperación del secreto:** **no existe.** Si se olvida el PIN o la frase, hay que quitar la copia y descargarla otra vez con conexión.
- **Corrupción:** si falla el descifrado, la autenticación del cifrado o el formato (meta o contenido), la copia se presenta como dañada y se ofrece borrarla y volver a descargarla.
- **Cuota:** un `QuotaExceededError` (o el equivalente de Firefox) se traduce a un mensaje claro y no deja copia. Una copia de más de 25 MiB se rechaza antes de escribir.

## 4. Contenido de la copia

Proyección con **lista blanca** (`buildOfflineSnapshot`, formato `1`) sobre la misma lectura consistente que la exportación (`readExportLibrary`).

| Sección | Incluido | Excluido |
| --- | --- | --- |
| Libros, ediciones y ejemplares | ID del ejemplar, título, subtítulo, autores, editoriales, fecha de publicación, páginas, ISBN o `null`, estantería, edición (ID, ejemplares que la comparten, obra, idioma) | Portadas (URL y assets privados), procedencia bibliográfica, identificadores externos, comprobación física y evidencias, tokens de versión |
| Estado de lectura | Estado actual (`status`) | **Historial de lectura:** ciclos y sesiones |
| Préstamos | Solo «Prestado» si hay un préstamo activo | **Alias del prestatario**, fechas, vencimiento y notas del préstamo |
| Datos personales | Etiquetas del ejemplar | **Notas privadas** y valoración |
| Estanterías | ID, título, predeterminada y recuento | — |
| Ubicaciones | ID, nombre, tipo y ubicación padre; balda y posición del ejemplar | Fotos de ubicación |
| Series | ID y título; posición y etiqueta del volumen | Descripción |
| Etiquetas | ID y nombre | — |
| Cuenta | Identificador opaco (SHA-256 del id con dominio propio) y **correo enmascarado** (`l•••@b•••.test`) | Id de usuario, correo completo, nombre, avatar y cualquier otro dato de cuenta |

## 5. Aislamiento por cuenta

- Cada cuenta tiene **su base IndexedDB**, `biblib-offline-<32 hex del identificador opaco>`. Nunca se comparte ni se lista una copia de otra cuenta.
- La vista sin conexión solo abre la copia de la **última cuenta que usó el dispositivo con conexión** (`localStorage["biblib-offline-cuenta"]`, que guarda el identificador opaco, no el id). Al entrar otra cuenta, la vista anterior queda bloqueada; si la copia está abierta en otra pestaña, se bloquea al cambiar la cuenta o al caducar.
- Una base copiada sobre la de otra cuenta no se abre: la meta está ligada a la cuenta y el cifrado autentica la cuenta.

## 6. Cierre de sesión y reconexión

| Situación | Efecto |
| --- | --- |
| Cierre de sesión desde BibLib (también al eliminar la cuenta) | Se borran la base de la cuenta (clave envuelta y datos) y el puntero, **antes** de cerrar la sesión en Supabase. |
| Supabase cierra la sesión (`SIGNED_OUT`): otra pestaña, o sesión revocada o vencida al reconectar | Se borra la copia de esa cuenta. |
| Reconexión con sesión válida de la misma cuenta | Se reinicia el TTL (validación con conexión). |
| Reconexión con otra cuenta | La copia anterior queda bloqueada para la vista; no se borra. |
| Reconexión sin sesión (caducada sin evento) | No se valida: la copia vence con su TTL. |
| Dispositivo desconectado | Nada puede borrarla a distancia ni invalidarla antes de que vuelva a conectarse o venza el TTL. |

## 7. Escrituras y textos

- **Nunca** se encolan ni se sincronizan escrituras hechas sin conexión. En `/offline` solo hay búsqueda y filtro en memoria, «Bloquear copia» y, si está dañada, «Borrar la copia dañada»; ningún control parece guardar.
- Los textos no prometen revocación remota en un dispositivo desconectado ni protección frente a XSS: dicen que el cifrado protege la copia guardada, no lo que se ve mientras está abierta, y que en un dispositivo sin conexión nada la borra antes de que se reconecte o caduque.

## 8. Cabeceras

- `sw.js` y `/offline` salen con `Cache-Control: private, no-store` y `Vary: Cookie` (regla única de `next.config.mjs`, sin cambios en la matriz de U-OPS-04). El worker se registra con `updateViaCache: "none"`.
- El worker guarda `/offline` en Cache Storage de forma explícita, pedida sin cookies; la cabecera `no-store` no impide esa copia propia ni la convierte en caché HTTP.
- La matriz `scripts/security/headers-matrix.mjs` incluye `/offline` (anónimo y con sesión, HTML público) y `/sw.js` (tipo `service-worker`).
