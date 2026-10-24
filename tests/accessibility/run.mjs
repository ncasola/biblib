import { main } from "../e2e/run.mjs"

// Conserva las guardas, build, sesiones, manifiesto y limpieza del runner E2E.
process.exitCode = await main(process.argv.slice(2), "tests/accessibility/playwright.config.ts")
