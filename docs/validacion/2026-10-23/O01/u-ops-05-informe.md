# Informe U-OPS-05 · Mantenimiento y restos del prototipo (O01)

**Fecha:** 23 de octubre de 2026 · **Rama:** `u-ops-05` (worktree hijo de `feature/spec-pendientes`) · **Hallazgos:** FE-04, SEC-01.

## Resumen

Se retiraron las pantallas de Auth de métodos inexistentes (con redirección a `/login`), los métodos deshabilitados del contexto de Auth, `public/data.json` y 47 archivos de UI sin consumidores (45 componentes de `components/ui` más los hooks `use-toast` y `use-mobile`). Se anexaron reglas de ignorado para archivos personales y se creó `docs/mantenimiento.md`, enlazado desde el README. Las dependencias huérfanas resultantes **no se tocaron**: quedan inventariadas abajo con su evidencia para que el coordinador las retire al consolidar la ola (el lockfile lo posee otra unidad).

## 1 · Rutas de Auth

- **Retiradas:** `app/(auth)/signup/page.tsx` y `app/(auth)/forgot-password/page.tsx`, pantallas informativas del prototipo cuyo único botón real apuntaba a `/login`. El acceso publicado es exclusivamente Google OAuth (`signInWithGoogle` en `lib/auth-context.tsx`).
- **Redirecciones:** `next.config.mjs` redirige `/signup` y `/forgot-password` a `/login` (`permanent: false`) para no romper marcadores; al ejecutarse antes que el proxy, se retiró `"/signup"` de la lista de rutas de acceso de `proxy.ts`.
- **Métodos deshabilitados eliminados** de `lib/auth-context.tsx`: `signIn`, `signUp`, `resetPassword` y `updatePassword` (todos lanzaban error). Evidencia de ausencia de consumidores: `grep -rE '\b(signIn|signUp|resetPassword|updatePassword)\b'` sobre `*.ts,*.tsx` solo encontraba las propias declaraciones del contexto.
- **Criterio de aceptación 1 verificado:** grep de `/signup|forgot-password` en `app/` y `components/` → 0 resultados (las únicas apariciones restantes son la redirección de `next.config.mjs`, la expresión de defensa de `lib/auth-navigation.ts` y los tests del propio módulo).
- **Conservado deliberadamente:** la expresión regular de `lib/auth-navigation.ts` sigue excluyendo `signup|forgot-password` como destinos de redirección post-acceso. Es endurecimiento barato cubierto por `tests/auth-navigation.test.ts`; como esas rutas ahora redirigen a `/login`, el comportamiento es equivalente y sin bucles.

## 2 · `public/data.json` y componentes sin uso

- **`public/data.json` retirado:** 6 libros y 3 estanterías mock del prototipo. Su único consumidor documentado era `lib/storage.ts` (auditoría FE-04), que ya no existe. Evidencia: grep de `data\.json` sobre `*.ts,*.tsx,*.mjs,*.css,*.webmanifest` → solo documentos históricos (`docs/auditoria-2026-10-22.md`), que no se reescriben por política de la spec.
- **45 componentes de `components/ui` retirados** (quedan 12 con consumidores): `accordion, alert, aspect-ratio, breadcrumb, button-group, calendar, carousel, chart, checkbox, collapsible, command, context-menu, drawer, empty, field, form, hover-card, input-group, input-otp, item, kbd, menubar, navigation-menu, pagination, popover, progress, radio-group, resizable, scroll-area, separator, sheet, sidebar, skeleton, slider, sonner, spinner, switch, textarea, toast, toaster, toggle, toggle-group, tooltip, use-mobile.tsx, use-toast.ts`.
- **Método de verificación:** grafo estático de imports desde todos los puntos de entrada (`app/`, componentes de dominio, `lib/`, `proxy.ts`, `scripts/`, `hooks/`, `tests/`) más grep de confirmación por nombre de archivo. No existen imports dinámicos (`grep 'next/dynamic|import\('` → 0). Referencias cruzadas encontradas (por ejemplo `separator` desde `sidebar`/`field`/`item`/`button-group`) eran internas al propio cluster muerto.
- **Cadena toast muerta:** nadie monta `<Toaster />` (ni el de `ui/toaster.tsx` ni el de sonner); `ui/toaster.tsx` era el único consumidor de `hooks/use-toast.ts`, y `ui/use-toast.ts` era una copia duplicada. Se retiraron `toast.tsx`, `toaster.tsx`, `use-toast.ts` (ui y hooks).
- **Hooks retirados:** `hooks/use-toast.ts` y `hooks/use-mobile.ts` (este último solo lo consumían `ui/sidebar.tsx` y `ui/use-mobile.tsx`, ambos retirados). Queda `hooks/use-theme.ts`, con consumidores reales.
- **Conservados pese a aparecer en la auditoría:** `components/theme-provider.tsx` (lo monta `app/layout.tsx`) y `hooks/use-theme.ts` (lo usa `components/header.tsx`). El diagnóstico original es histórico y no se reescribió.
- **Fixtures de pruebas intactos:** `tests/fixtures/library/` (biblioteca sintética de 111 fichas) y `tests/` no se tocaron.

## 3 · Dependencias candidatas a retirar (NO tocadas)

Lockfile y `package.json` pertenecen a otra unidad de la ola; esto es el inventario con evidencia. Tras las retiradas, el grep de confirmación sobre todo el código (`*.ts,*.tsx,*.mjs,*.css`, incluidos `app/`, `components/`, `lib/`, `hooks/`, `scripts/`, `proxy.ts`, configs) con la expresión que agrupa las 32 candidatas devuelve **0 resultados**.

| Dependencia | Evidencia |
| --- | --- |
| `@hookform/resolvers` | Nunca tuvo imports en el código. |
| `@radix-ui/react-accordion` | Único consumidor: `ui/accordion.tsx` (retirado). |
| `@radix-ui/react-aspect-ratio` | Único consumidor: `ui/aspect-ratio.tsx` (retirado). |
| `@radix-ui/react-checkbox` | Único consumidor: `ui/checkbox.tsx` (retirado). |
| `@radix-ui/react-collapsible` | Único consumidor: `ui/collapsible.tsx` (retirado). |
| `@radix-ui/react-context-menu` | Único consumidor: `ui/context-menu.tsx` (retirado). |
| `@radix-ui/react-hover-card` | Único consumidor: `ui/hover-card.tsx` (retirado). |
| `@radix-ui/react-menubar` | Único consumidor: `ui/menubar.tsx` (retirado). |
| `@radix-ui/react-navigation-menu` | Único consumidor: `ui/navigation-menu.tsx` (retirado). |
| `@radix-ui/react-popover` | Único consumidor: `ui/popover.tsx` (retirado). |
| `@radix-ui/react-progress` | Único consumidor: `ui/progress.tsx` (retirado). |
| `@radix-ui/react-radio-group` | Único consumidor: `ui/radio-group.tsx` (retirado). |
| `@radix-ui/react-scroll-area` | Único consumidor: `ui/scroll-area.tsx` (retirado). |
| `@radix-ui/react-separator` | Únicos consumidores: `ui/separator.tsx` y retirados (`sidebar`, `field`, `item`, `button-group`). |
| `@radix-ui/react-slider` | Único consumidor: `ui/slider.tsx` (retirado). |
| `@radix-ui/react-switch` | Único consumidor: `ui/switch.tsx` (retirado). |
| `@radix-ui/react-toast` | Único consumidor: `ui/toast.tsx` (retirado con la cadena toast muerta). |
| `@radix-ui/react-toggle` | Único consumidor: `ui/toggle.tsx` (retirado). |
| `@radix-ui/react-toggle-group` | Único consumidor: `ui/toggle-group.tsx` (retirado). |
| `@radix-ui/react-tooltip` | Único consumidor: `ui/tooltip.tsx` (retirado). |
| `autoprefixer` | No aparece en `postcss.config.mjs` (solo `@tailwindcss/postcss`); Tailwind v4 no lo necesita. Además figura en `dependencies` en lugar de `devDependencies`. |
| `cmdk` | Único consumidor: `ui/command.tsx` (retirado). |
| `date-fns` | Sin imports directos; era peer de `react-day-picker` para `ui/calendar.tsx` (retirado). |
| `embla-carousel-react` | Único consumidor: `ui/carousel.tsx` (retirado). |
| `input-otp` | Único consumidor: `ui/input-otp.tsx` (retirado). |
| `react-day-picker` | Único consumidor: `ui/calendar.tsx` (retirado). |
| `react-hook-form` | Único consumidor: `ui/form.tsx` (retirado). |
| `react-resizable-panels` | Único consumidor: `ui/resizable.tsx` (retirado). |
| `recharts` | Único consumidor: `ui/chart.tsx` (retirado). |
| `sonner` | Único consumidor: `ui/sonner.tsx` (retirado; nadie montaba su `<Toaster />`). |
| `tailwindcss-animate` | Sin referencias: `app/globals.css` importa `tw-animate-css` (devDependency). Resto de la era Tailwind v3. |
| `vaul` | Único consumidor: `ui/drawer.tsx` (retirado). |

**No candidatas**, verificadas con consumo real: `react-dom` (peer/runtime de Next aunque sin imports directos), `@types/*`, `typescript`, `eslint`, `eslint-config-next` (`eslint.config.mjs`), `postcss` y `@tailwindcss/postcss` (`postcss.config.mjs`), `tailwindcss` y `tw-animate-css` (`@import` en `globals.css`), y el resto con importers vivos: `next`, `react`, `@supabase/ssr`, `@supabase/supabase-js`, `@vercel/analytics` (`app/layout.tsx`), `class-variance-authority`, `clsx`, `tailwind-merge`, `zod`, `drizzle-orm`, `drizzle-kit` (`drizzle.config.ts`), `postgres`, `server-only`, `lucide-react`, `next-themes`, y los radix `alert-dialog`, `avatar`, `dialog`, `dropdown-menu`, `label`, `select`, `slot`, `tabs`.

## 4 · Archivos personales y mantenimiento

- `.gitignore` anexó (sin tocar reglas previas, verificadas con `git check-ignore`): `/imports/`, `/fotos/`, `/fotos-personales/` y `docs/validacion/**/privado/`. Reglas preventivas: no existen aún esas rutas y no se borró, movió ni publicó ninguna foto.
- `docs/mantenimiento.md` documenta la política de actualización (lockfile congelado, versiones fijadas, advisories, sin `latest`, validación en preproducción), el inventario de scripts existentes, las decisiones de `allowBuilds` de `pnpm-workspace.yaml` y la guía de contribución. Enlazado desde `README.md` con una línea.

## 5 · Validación ejecutada (resultados reales)

| Comando | Resultado |
| --- | --- |
| `pnpm lint` | Verde, sin avisos. |
| `pnpm typecheck` | Verde (`next typegen` + `tsc --noEmit`). |
| `pnpm test` | Verde: 50/50 pruebas unitarias. |
| `pnpm test:scripts` | No existe todavía (lo crea U-INF-01). |
| `pnpm build` | Verde con los placeholders públicos de CI (`NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co`, `NEXT_PUBLIC_SUPABASE_ANON_KEY=ci-public-placeholder`, idénticos a `.github/workflows/ci.yml`): 14/14 páginas, sin rutas `/signup` ni `/forgot-password`. Sin esas variables públicas el prerender de `/_not-found` falla por diseño preexistente de `lib/supabase/client.ts`, no por las retiradas de esta unidad. |

Stack `scratch` no levantado: la unidad no lo requiere. No se leyó `.env`, no se tocó la base remota ni contenedores ajenos.

## 6 · Fuera de scope (no realizado)

`supabase/`, `scripts/` (excepto su análisis como consumidores), `drizzle*`, `lib/db`, `package.json`/`pnpm-lock.yaml`/`pnpm-workspace.yaml` y `docs/operacion.md` (la unidad no requería sección allí; `docs/mantenimiento.md` es el documento nuevo y enlazado). La auditoría y la spec existentes se conservaron como documentos históricos.
