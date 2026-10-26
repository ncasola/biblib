import "server-only"
import postgres from "postgres"
import { telemetry } from "../observability/server"
import { readCatalogConfig } from "./config"
import { createCatalogGateway, createPostgresCoordinationStore, type CoordinationStore } from "./gateway"
import { createConfiguredCatalog } from "./registry"

// Valida la configuración al cargar el servidor, antes de servir fixtures.
const config = readCatalogConfig()

const unconfigured = () => Promise.reject(new Error("La coordinación del catálogo no está configurada."))
const unconfiguredStore: CoordinationStore = { begin: unconfigured, complete: unconfigured, reserve: unconfigured, release: unconfigured, privateGet: unconfigured, privatePut: unconfigured, invalidate: unconfigured }

/**
 * Conexión propia de coordinación (U-DAT-05), separada de las transacciones de dominio y con plazos
 * cortos: si Postgres no responde, el gateway devuelve `unavailable` en lugar de consultar al
 * proveedor sin cuota. Sin URL, toda consulta live queda en `unavailable`.
 */
function coordinationStore(): CoordinationStore {
  const url = process.env.SUPABASE_DB_URL
  if (!url) return unconfiguredStore
  const shared = globalThis as typeof globalThis & { biblibCatalogueSql?: postgres.Sql }
  shared.biblibCatalogueSql ??= postgres(url, {
    max: 2,
    prepare: false,
    ssl: ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname) ? false : "require",
    idle_timeout: 20,
    connect_timeout: 5,
    connection: { application_name: "biblib-catalogue", statement_timeout: 3000, lock_timeout: 2000 },
  })
  return createPostgresCoordinationStore(shared.biblibCatalogueSql)
}

// Los fixtures no salen a la red: solo el modo live necesita cuota y caché compartidas.
const secret = process.env.BIBLIB_CATALOGUE_CACHE_SECRET
const gateway = config.mode === "live"
  ? createCatalogGateway({ store: coordinationStore(), telemetry, privateKeySecret: secret && secret.length >= 32 ? secret : undefined })
  : undefined

export const bibliographicCatalog = createConfiguredCatalog(config, { telemetry, fetch: gateway?.fetch, gateway })
