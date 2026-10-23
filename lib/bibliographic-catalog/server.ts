import "server-only"
import { telemetry } from "../observability/server"
import { createConfiguredCatalog } from "./registry"

// Valida la configuración al cargar el servidor, antes de servir fixtures.
export const bibliographicCatalog = createConfiguredCatalog(undefined, { telemetry })
