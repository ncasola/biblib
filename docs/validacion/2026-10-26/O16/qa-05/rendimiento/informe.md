# Benchmark final frente a G09 · U-QA-05 (O16)

**Fecha:** 26 de octubre de 2026 · **Commit medido:** `b02afe7`, rama `u-qa-05` (head `0015`, modelo obra/edición/ejemplar). U-EXP-07 no cambia acciones ni schema · **Perfil:** `scratch`.

**Referencia:** la medición de G09 ([rendimiento/2026-10-23](../../../../rendimiento/2026-10-23/informe.md), perfil `test`, head `0005`, antes de U-DAT-04 y U-DAT-06) y la de restauración de U-DAT-04 ([O11/dat-04](../../../../2026-10-24/O11/dat-04/medicion-restauracion.json), head `0008`).

**Comandos:**

```powershell
pnpm perf:local --profile scratch --scale 100 --scale 1000 --scale 10000 --out docs/validacion/2026-10-26/O16/qa-05/rendimiento
pnpm perf:restore --profile scratch --scale 100 --scale 1000 --scale 10000 --repeat 3 --out docs/validacion/2026-10-26/O16/qa-05/rendimiento/restauracion.json
```

**Duración:** `perf:local`, 22 min 33 s, salida 0; `perf:restore`, 56 s, salida 0.

**Archivos:**
- Datos brutos: [tablas.md](tablas.md), `contrato.json`, `resultados-<tamaño>.json`, `explain-<tamaño>.txt`, `auth.json`, `cuota.json` y [manifiesto.json](manifiesto.json).
- Restauración: `restauracion.json`.

## Si se puede comparar y qué cambia

Se repitió el mismo comando, con los mismos datasets deterministas de 100, 1 000 y 10 000 ejemplares y el mismo hardware (Ryzen 5 3600, Docker Desktop 29.4.3 con 12 CPU y 19,5 GiB). Es comparable en órdenes de magnitud, con cuatro diferencias declaradas:

1. **Perfil:** `scratch` en lugar de `test`. La configuración del stack es la misma, generada desde `supabase/config.toml`; cambian los puertos.
2. **Ruido:** en la máquina había 16 contenedores ajenos en marcha (los perfiles `main` y `test` de otros checkouts); en G09, 18.
3. **Código:** el producto ya no es el de G09. La lectura y la escritura pasan por el modelo obra/edición/ejemplar (vista `books`) y hay pool de 4 conexiones (U-FIX-02, T4), una sola verificación de sesión por petición, staging con publicación atómica (U-DAT-04), trabajos de portadas (U-DAT-03), producto de O13–O14 y rediseño.
4. **Escenarios:** `ajustes-recuentos` y `exportacion-servidor` sustituyen a la lectura completa de Ajustes, retirada en T1, y no tienen presupuesto propio.

## Resultados (acción p50 / p95 en ms, 1 sesión salvo `@N`)

| Escenario | G09 · 10 000 | Final · 10 000 | Final · 1 000 | Final · 100 |
| --- | --- | --- | --- | --- |
| Inicio (resumen) | 142 / 167 | 79 / 87 | 80 / 137 | 74 / 108 |
| Listado inicial | 135 / 229 | 75 / 86 | 84 / 121 | 78 / 139 |
| Listado inicial @10 | 338 / 372 | 145 / 184 | 152 / 203 | 345 / 729 |
| Listado de 100 filas | 139 / 167 | 79 / 89 | 77 / 99 | 130 / 188 |
| Última página | 147 / 164 | 94 / 112 | 71 / 84 | 83 / 116 |
| Búsqueda local (texto) | 221 / 312 | 96 / 111 | 73 / 88 | 95 / 114 |
| Búsqueda local (texto) @10 | **1 198 / 1 278** | 193 / 255 | 169 / 268 | 189 / 268 |
| Búsqueda local (ISBN) | 215 / 256 | 96 / 116 | 78 / 148 | 65 / 99 |
| Ficha | 107 / 129 | 63 / 75 | 63 / 74 | 66 / 103 |
| Estanterías | 124 / 147 | 66 / 77 | 66 / 103 | 66 / 103 |
| Estantería 3D (48) | 117 / 201 | 80 / 98 | 79 / 98 | 67 / 83 |
| Preview de importación («nuevos», 2 000) | 363 / 403 | 366 / 435 | 200 / 217 | 111 / 120 |
| Preview «nuevos» @10 | 2 390 / 2 966 | 2 159 / 2 825 | 1 135 / 1 468 | 370 / 449 |
| Recuentos de Ajustes (sustituye a la lectura completa de 524 / 576 y 6,7 MiB) | — | 67 / 77 | 65 / 160 | 58 / 69 |
| Exportación por partes en el servidor | — | 732 / 799 | 236 / 257 | 83 / 96 |
| Exportación @10 | — | 5 024 / 7 519 | 651 / 958 | 213 / 350 |

**SQL real de la acción a 10 000 (p95):**

| Acción | G09 | Final |
| --- | --- | --- |
| Resumen | 21,5 ms | 16,0 ms |
| Listado | 21,0 ms | 7,3 ms |
| Búsqueda por ISBN | 124 ms | 34,5 ms |

Todas quedan dentro del presupuesto de 500 ms.

## Presupuestos incumplidos

| Medida | G09 | Final |
| --- | --- | --- |
| Acciones con 5–10 sesiones (inicio, listado de 100, búsqueda de texto e ISBN, ficha @10 con 100) | 6 fuera de presupuesto (hasta 1 278 ms) | **0**: todas ≤ 1 000 ms; el peor p95 es 729 ms (listado @10 con 100) |
| INP móvil (CPU ×4) en Estanterías / ficha | 496 / 216 ms | 176 / 120 ms (presupuesto 200) |
| CLS de Ajustes al exportar (escritorio / móvil) | 0,169 / 0,579 | 0,004 / 0,005 |
| **CLS de Inicio, escritorio** | 0 | **0,159 en los tres tamaños** (presupuesto 0,1) |

El CLS de Inicio en escritorio es una **regresión nueva**. Aparece igual con 100, 1 000 y 10 000 ejemplares, así que no depende del volumen y apunta al diseño de la pantalla de inicio posterior a G09 (rediseño U-UX-01 o tarjetas de lectura de U-PRO-02). En móvil es de 0,039, dentro de presupuesto. Corregirlo queda fuera de U-QA-05: se propone como tarea de U-UX-01/U-EXP-03, con `layout-shift` en el inicio y espacio reservado para las tarjetas que cargan después.

## Cambio de modelo, restauración, conexiones, workers y límites globales

- **Cambio de modelo (U-DAT-06):** las lecturas sobre la vista plana no empeoran frente a G09; mejoran entre 1,5 y 6 veces, incluido el efecto de U-FIX-02 (una llamada a GoTrue por petición). La preview de importación sigue igual a 10 000 (363 → 366 ms).
- **Restauración atómica por partes (`perf:restore`, p50 de 3 repeticiones, presupuesto de publicación de 15 s):**

  | Libros | Validación O11 → final | Preparación O11 → final | Publicación, colección pequeña | Publicación, colección llena |
  | --- | --- | --- | --- | --- |
  | 100 | 60 → 69 ms | 25 → 29 ms | 52 → 95 ms | 57 → 116 ms |
  | 1 000 | 174 → 173 ms | 49 → 68 ms | 124 → 250 ms | 247 → 603 ms |
  | 10 000 | 1 359 → 1 504 ms | 326 → 489 ms | 1 343 → 2 183 ms | **1 977 → 4 233 ms** |

  La publicación con la colección llena tarda unas 2 veces más que en O11. Ahora captura y sustituye el modelo obra/edición/ejemplar y las secciones de producto de O13–O14 en la misma transacción. Con 4,2 s sigue dentro del presupuesto de 15 s (`cumple: true` en los tres tamaños), sin commits parciales. Si la colección crece por encima de 10 000, es lo primero que conviene vigilar.
- **Conexiones:** la app mantiene **4 conexiones** `postgres.js` (pool `max: 4` de U-FIX-02; G09 tenía 1). El total del perfil es 10 de 100. En la prueba de cuota, el máximo fue de 2 conexiones activas y **0 inactivas en transacción** mientras se espera la plaza.
- **Workers y límites globales:** la cuota distribuida con dos procesos independientes separa las plazas del proveedor simulado ≥ 1 000 ms (mínima observada: 983 ms, con 17 ms de jitter; `cumpleIntervalo: true`), igual que en G09. Aislamiento bajo carga de 10 sesiones: 828 comprobaciones, 0 violaciones (G09: 760). Guard de red: 0 salidas del servidor y del navegador. El rendimiento de los workers de portadas (U-DAT-03) no tiene escenario en `perf:local`: su corrección bajo concurrencia está en el grupo `jobs` y no se midió aquí su caudal.
- **Exportación por partes con 10 sesiones a 10 000:** p50 5 s, sin presupuesto definido. Es una operación poco frecuente, pero conviene limitarla por cuenta si el alojamiento comparte instancias.

## Limitaciones

Es un Postgres local en Docker con la configuración por defecto del stack y contenedores ajenos en marcha. Las cifras comparan versiones del producto, no son un SLA ni dicen nada del rendimiento remoto. El frío es el de la aplicación: no se vacía la caché de Postgres. Rendimiento con red, pooler y alojamiento reales: **pendiente externo** (Néstor).
