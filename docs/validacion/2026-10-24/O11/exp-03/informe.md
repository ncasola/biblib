# U-EXP-03 · Evidencia O11

Validación en curso; los resultados finales se incorporan al terminar las suites. Perfil exclusivo `test` de este worktree, sin base remota, datos ficticios y sin modificar recursos de HolaERP.

## Incidencia adicional autorizada: promoción/restauración

El coordinador autorizó el 24-10-2026 una corrección aislada de `tests/scripts/promotion-harness.mjs`: creación idempotente de `anon`, ya presente en `tests/db/bootstrap.sql`. Commit `281536a`. La primera ejecución completa de `pnpm test:scripts` canceló los ocho casos de promoción por el rol duplicado; tras ese cambio pasaron siete y el caso 7 detectó una diferencia de representación del check de vistas guardadas.

Antes de corregirla, un ensayo con **dos Postgres efímeros propios**, migraciones hasta `0007`, datos sintéticos, `pg_dump` y restauración identificó **una única diferencia**, en `constraints`, objeto `biblib.saved_book_views.saved_book_views_name_check`:

Antes del dump, `pg_get_constraintdef` devuelve:

```sql
CHECK ((((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 80)) AND (name = btrim(name))))
```

Después de restaurar el mismo dump devuelve:

```sql
CHECK (((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 80) AND (name = btrim(name))))
```

Son los mismos tres predicados conjuntivos, con una agrupación redundante diferente; nombre, tabla, tipo, validación, columnas y restantes hechos son idénticos. El ledger y el manifest pasan. El coordinador autorizó normalizar **solo** esta representación concreta, sin excluir objetos ni relajar diferencias semánticas. La comparación conservará todos los checks/grants/políticas/índices y cualquier otra diferencia textual.

Se conserva como representación canónica la que produce la migración, para mantener las huellas de los respaldos ya creados directamente desde ella; solo se transforma la cadena exacta producida tras restaurar. No se aplica un borrado general de paréntesis.
