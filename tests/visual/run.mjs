import { main } from "../e2e/run.mjs"

// U-UX-01: capturas de evidencia del rediseño con las guardas, build, sesiones y limpieza del runner E2E.
// Uso: UX_CAPTURE_PHASE=antes|despues node tests/visual/run.mjs [--reuse-build]
process.exitCode = await main(process.argv.slice(2), "tests/visual/playwright.config.ts")
