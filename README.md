# BibLib

BibLib es una biblioteca personal construida con Next.js, Supabase y Drizzle ORM.

## Variables de entorno

Crea un archivo `.env.local` con estas variables:

```bash
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_DB_URL=...
```

Notas:
- `NEXT_PUBLIC_SUPABASE_URL` y `NEXT_PUBLIC_SUPABASE_ANON_KEY` se usan para Auth SSR y cliente.
- `SUPABASE_DB_URL` se usa por Drizzle para ejecutar migraciones SQL.
- El login está configurado para Google OAuth.

## Comandos

```bash
pnpm install
pnpm dev
pnpm lint
pnpm db:generate
pnpm db:migrate
```

## Migración incluida

La migración SQL inicial está en `drizzle/0000_biblib_init.sql` e incluye:
- Creación del schema `biblib`.
- Tablas `biblib.shelves` y `biblib.books`.
- Índices y constraints.
- RLS por usuario (`auth.uid()`) para `SELECT/INSERT/UPDATE/DELETE`.
