# U-PRO-01 · Notas, etiquetas y valoración personal

Fecha: 25-10-2026. Rama: `u-pro-01`, hija de `feature/spec-pendientes`, sobre U-EXP-05 (`32413f7`). Sin levantar perfiles Supabase.

## Entrega

- `copy_annotations` y `copy_tags` son del ejemplar. Las acciones de `copy-personal.ts` reciben `copyId`, `expectedVersion` (UUID o `null` si aún no había anotación) y el conjunto de campos personales. Guardan notas, valoración y vínculos en una transacción con contexto RLS y bloqueo de colección.
- Notas de hasta 4000 puntos de código; valoración entera 1–5 o vacía; máximo 20 etiquetas de 40 caracteres. La validación no recorta datos y rechaza NUL en notas y controles en nombres.
- Las altas manual y bibliográfica guardan los campos opcionales en la misma transacción que el primer ejemplar, incluyendo esos campos en el hash de idempotencia. Crear otra copia no hereda datos personales.
- Etiquetas por nombre normalizado del contrato: colapsar espacios, ignorar mayúsculas y diacríticos, conservar ñ. Se reutilizan con comprobación indexada, `ON CONFLICT DO NOTHING` y relectura; el bloqueo de colección serializa también las creaciones simultáneas y las cuotas.
- Crear, renombrar y borrar etiquetas comprueba dueño y versiones. Renombrar/borrar rota también la versión personal de las copias afectadas, incluso si llegaron por importación sin fila de anotación. La cascada retira vínculos y conserva los libros.
- Formulario de alta con campos opcionales y radios nativos de estrellas, etiquetas accesibles y equivalente textual. Se conserva el alta consecutiva, su puerta contra doble envío y los cambios de cámara. El siguiente formulario empieza sin notas ni valoración.
- Ficha con sección propia para consultar y editar los campos personales. Un conflicto conserva el borrador y ofrece una recarga explícita. La edición bibliográfica sigue su propio formulario.
- Colección y búsqueda avanzada comparten selección múltiple de etiquetas, OR predeterminado y AND explícito. URL reproducible mediante `tag=<uuid>` repetido y `tagMode=and`; cambiar filtros reinicia la página. Las etiquetas no cambian la estantería.
- El filtro agrupa únicamente los vínculos del dueño y las etiquetas elegidas sobre el índice `(user_id, tag_id)`, antes de contar y paginar. Solo se enriquecen las copias de la página con dos consultas acotadas, sin N+1.

## Verificación ejecutada

| Comando | Resultado | Evidencia |
| --- | --- | --- |
| `pnpm test` | 393/393, 0 fallos | [unitarias.log](unitarias.log) |
| `pnpm test:scripts` | 261 superadas, 0 fallos, 2 omitidas por falta de scratch acreditado | [scripts.log](scripts.log) |
| `pnpm test:db` | Verde, migraciones hasta 0014 y pruebas SQL, contenedor efímero retirado | [db.log](db.log) |
| `pnpm lint` | Verde | [lint.log](lint.log) |
| `pnpm typecheck` | Verde | [tipos.log](tipos.log) |
| `pnpm build` | Verde, Next.js 16.4.2 | [build.log](build.log) |
| `pnpm test:smoke` | 12 comprobaciones, Auth simulado y Postgres efímero, sin HTTP externo | [smoke.log](smoke.log) |
| `node --check tests/integration/personal/{run,personal.test}.mjs` | Sintaxis válida | Ejecutado sin stack |
| `pnpm exec playwright test tests/e2e/flujos/personal.spec.ts --list` | 4 recorridos descubiertos en Chromium, Firefox y WebKit (más dependencias de sesión) | [e2e-discovery.log](e2e-discovery.log) |

Los sustitutos de acciones en las pruebas SSR existentes se ampliaron para la nueva lectura de etiquetas; siguen fallando si se intenta consultar durante el renderizado. No se añadieron sustitutos al producto.

## Pruebas que ejecutará el coordinador

Grupo registrado en `SUITES`: `personal`. Runner: `pnpm test:integration:personal --profile test` (también admite `scratch` acreditado y `--reuse-build`); sin levantar, migrar o sembrar servicios desde el runner. Reutiliza el contexto de cuentas desechables del grupo `product`, con GoTrue real, llamadas HTTP a Server Actions y limpieza de cuentas por run.

Diez escenarios cubren alta atómica e idempotente, copia nueva vacía, CRUD y límites, Unicode y duplicados simultáneos, usuario cruzado, concurrencia con token inicial nulo y con tokens existentes, renombrado/borrado, vínculo importado sin anotación, filtros OR/AND y paginación, ida y vuelta v2 y reemplazo antiguo, y cuota de 1000 etiquetas con reutilización de nombres existentes. Las pruebas v2, snapshots, respaldo y eliminación que ya aporta `product` se conservan.

E2E nuevo: `tests/e2e/flujos/personal.spec.ts`: alta consecutiva con estrellas por teclado; conflicto y recarga; OR/AND y persistencia de URL en ambas rutas; renombrado/borrado sin eliminar el libro. **Descubiertos y tipados, aún no ejecutados contra el perfil test** por la asignación sin stack.

## Límites, integración y recursos

No se escribió schema ni migración; v2, snapshots, respaldo, restore y eliminación de cuenta usan el contrato 0014 existente. El token `personalVersion` es efímero de interfaz y no entra en exportaciones.

Los cambios compartidos son aditivos: montaje de la sección personal en `components/book-details-screen.tsx`, validación opcional en `lib/book-validation.ts`, lectura/alta atómica en `lib/db/editions.ts`, filtros en `app/actions/library.ts` y `lib/book-search.ts`, registro de la suite y un script al final de `package.json`. Otras unidades de O13 pueden integrar secciones junto a la personal sin editar sus componentes.

**Vistas guardadas, decisión conservadora:** la función SQL `saved_view_filters_valid` de 0007 admite únicamente los filtros anteriores y rechaza `tagIds/tagMode`. Se preguntó al coordinador por `orca orchestration ask` (`msg_5243eb62cff2`); al vencer los 10 minutos sin respuesta se aplicó la regla del encargo: no modificar schema y evitar pérdida silenciosa. Guardar o sobrescribir una vista con etiquetas activas da un mensaje claro y conserva los filtros; la URL sí los reproduce. Ampliar el contrato de vistas guardadas queda fuera de esta unidad, en un commit de protección aislado.

Se conservan los contenedores y datos ajenos. `test:db`, `test:scripts` y `test:smoke` retiraron sus contenedores efímeros; la consulta final por nombres `biblib-test-*` y `biblib-smoke-*` no devolvió contenedores. No se crearon ni se dejaron redes o volúmenes de perfiles Supabase de este worktree.
