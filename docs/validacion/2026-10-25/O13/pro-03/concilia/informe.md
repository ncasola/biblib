# U-PRO-03 · Conciliación con U-EXP-06 tras integrar `feature/spec-pendientes`

**Fecha:** 25-10-2026 · **Rama:** `u-pro-03` · **Base integrada:** `feature/spec-pendientes` en `a5ebe96` (U-PRO-05, U-DAT-07 y U-EXP-06) · **Perfil:** `test` (head `0014`).

## Qué se hizo

1. **Merge** de `feature/spec-pendientes` (`e9591c8`). Conflictos aditivos resueltos conservando ambos lados:
   - `components/header.tsx`: «Series» y «Ubicaciones».
   - `lib/auth-navigation.ts`: `/series` y `/locations`.
   - `scripts/security/headers-matrix.mjs`: `PROTECTED` y `REQUESTS` de ambos lados.
   - `SUITES`: `series`, `review`, `media` y `locations`.
   - `package.json`: los scripts de ambos lados.
   - `docs/operacion.md`: las secciones de U-PRO-05, U-DAT-07 y U-EXP-06, seguidas de la de U-PRO-03.
2. **`lib/media/server.ts` = la versión canónica de U-EXP-06, sin cambios** (`git diff feature/spec-pendientes -- lib/media/server.ts` vacío). No hizo falta añadir nada:
   - Sale del todo el helper mínimo de U-PRO-03 (`lib/media/images.ts` y las variantes con dueño explícito).
   - El paso compuesto «reservar → subir → registrar, o descartar si falla» es una función privada de `app/actions/locations.ts` (`storeLocationPhoto`).
3. **Foto de ubicación sobre la API canónica:**
   - Usa `beginUpload("location")`, `upload` (normaliza con `normalizeMediaImage`: ≤ 5 MiB y ≤ 4096 px por lado, WebP sin metadatos), `register` y `discard`.
   - Se mantiene la regla propia: la foto sustituida que cita una versión anterior no se descarta.
4. **Lectura:** se reutiliza `/api/media/:id` y se retira `/api/locations/:id/photo` (también de la matriz de cabeceras). `locationPhotoUrl` devuelve `/api/media/<asset>`.
5. **Pruebas adaptadas:**
   - Las unitarias usan `normalizeMediaImage`: 4096 px se aceptan y 4097 se rechazan.
   - Las de integración y el E2E leen por `/api/media/<asset>`. Se añadió una comprobación: la foto sustituida ya no se sirve (404).
6. **Arreglo del harness compartido** `tests/integration/lib/app.mjs` (commit aislado `49bce81`):
   - El fallo: `loadActions` enviaba `getProfileAvatarAction` (presente en todas las páginas por la cabecera) a `/(auth)/login`, porque no quitaba los grupos de rutas. Respondía 404 y el grupo `media` fallaba (`grupo-media-reuse-build.log`, `grupo-media-antes-del-arreglo.log`).
   - El arreglo: se prefiere una página fuera de grupos y de `_not-found`, y se quitan los segmentos `(…)` de la URL. El resto de acciones conservan su ruta.
   - El grupo `security` (que usa `signInWithLocalPasswordAction` por el mismo harness) sigue 23/23.

## Resultados

| Comando | Resultado | Log |
| --- | --- | --- |
| `pnpm lint` / `pnpm typecheck` | Correctos | `lint.log`, `typecheck.log` |
| `pnpm test` | 427/427 | `test.log` |
| `pnpm test:scripts` (tras el arreglo del harness) | 266 correctas, 2 omitidas, 0 fallos | `test-scripts.log` |
| `pnpm test:db` | Correcto | `test-db.log` |
| `pnpm build` / `pnpm test:smoke` | Correctos | `build.log`, `test-smoke.log` |
| `test:integration:locations --profile test` | 24/24 | `grupo-locations.log` |
| `test:integration:media --profile test` | 5/5 (tras el arreglo; antes, 4/5 por la ruta `/(auth)/login`) | `grupo-media.log` |
| `test:integration:product --profile test --reuse-build` | 17/17 | `grupo-product.log` |
| `test:integration:security --profile test --reuse-build` | 23/23 | `grupo-security.log` |
| `test:e2e:local --grep "ubicaciones:\|avatar"` (Chromium) | 3/3 (+ sesiones A/B) | `e2e-ubicaciones-avatar.log` |
| `db:local:down --profile test` | Correcto | `stack-down.txt` |

Orden y códigos de salida: `resumen-comandos.txt`.

- **`--reuse-build` con `media`:** el grupo `media` necesita su propio build. Su runner activa `BIBLIB_PRIVATE_MEDIA_UPLOADS=1`; las demás filas reutilizan el build de `locations`.
- **Recursos que quedan:** `recursos-restantes.txt`. Son la red `biblib-test-network` y los volúmenes `supabase_db_biblib-test` y `supabase_storage_biblib-test`; no queda ningún contenedor del perfil. HolaERP no se tocó.

## Notas

- El pendiente de purga del informe principal queda resuelto: U-EXP-06 aporta `pnpm media:purge:local`, que recoge las fotos sustituidas cuando ya nada las cita y los objetos que no se pudieron retirar.
- `normalizeMediaImage` hereda los mensajes de rechazo de las portadas (p. ej. «no se admite como portada», «10 megapíxeles»). Afecta también a las fotos de ubicación; se corrigen en `lib/assets/contracts.ts` (U-DAT-10/U-EXP-06), fuera de este scope.
