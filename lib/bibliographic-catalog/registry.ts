import type { TelemetryEmitter } from "../observability/emitter"
import { readCatalogConfig, type CatalogConfig } from "./config"
import type { CatalogGateway } from "./gateway"
import { createBibliographicCatalogService } from "./orchestrator"
import { createFixtureProvider } from "./providers/fixture"
import { createOpenLibraryProvider } from "./providers/open-library"
import { createBneSruProvider } from "./providers/bne-sru"
import { createGoogleBooksProvider } from "./providers/google-books"
import type { ProviderId, ProviderRegistration } from "./types"

export function createConfiguredCatalog(config: CatalogConfig = readCatalogConfig(), options: { telemetry?: TelemetryEmitter; order?: readonly ProviderId[]; fetch?: typeof fetch; gateway?: CatalogGateway } = {}) {
  const providers: ProviderRegistration[] = [
    { id: "open-library", enabled: config.enabled["open-library"], adapter: config.mode === "fixture" ? createFixtureProvider() : createOpenLibraryProvider({ fetch: options.fetch }) },
    { id: "bne", enabled: config.enabled.bne, ...(config.enabled.bne ? { adapter: config.mode === "fixture" ? createFixtureProvider("bne") : createBneSruProvider({ fetch: options.fetch }) } : {}) },
    { id: "google-books", enabled: config.enabled["google-books"], configured: config.mode === "fixture" || config.googleConfigured,
      ...(config.mode === "live" && config.enabled["google-books"] && config.googleConfigured
        ? { adapter: createGoogleBooksProvider({ enabled: true, mode: config.mode, fetch: options.gateway?.fetch ?? options.fetch }) } : {}) },
  ]
  return createBibliographicCatalogService({ providers, telemetry: options.telemetry, order: options.order, gateway: options.gateway })
}
