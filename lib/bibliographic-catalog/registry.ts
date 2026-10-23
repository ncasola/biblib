import type { TelemetryEmitter } from "../observability/emitter"
import { readCatalogConfig, type CatalogConfig } from "./config"
import { createBibliographicCatalogService } from "./orchestrator"
import { createFixtureProvider } from "./providers/fixture"
import { createOpenLibraryProvider } from "./providers/open-library"
import type { ProviderId, ProviderRegistration } from "./types"

export function createConfiguredCatalog(config: CatalogConfig = readCatalogConfig(), options: { telemetry?: TelemetryEmitter; order?: readonly ProviderId[]; fetch?: typeof fetch } = {}) {
  const providers: ProviderRegistration[] = [
    { id: "open-library", enabled: config.enabled["open-library"], adapter: config.mode === "fixture" ? createFixtureProvider() : createOpenLibraryProvider({ fetch: options.fetch }) },
    // O08/O09 aportarán adaptadores reales. No se simulan capacidades live.
    { id: "bne", enabled: config.enabled.bne },
    { id: "google-books", enabled: config.enabled["google-books"], configured: config.mode === "fixture" || config.googleConfigured },
  ]
  return createBibliographicCatalogService({ providers, telemetry: options.telemetry, order: options.order })
}
