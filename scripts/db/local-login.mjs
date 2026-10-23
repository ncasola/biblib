import { randomBytes, timingSafeEqual } from "node:crypto"
import { createServer } from "node:http"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { serializeCookieHeader } from "@supabase/ssr"
import { signInFixture } from "../../tests/integration/support/session.mjs"
import { BiblibError, EXIT } from "../lib/exit-codes.mjs"
import { getProfile } from "../lib/profiles.mjs"

export async function localLogin(argv = process.argv.slice(2)) {
  let as, profile = process.env.BIBLIB_PROFILE || "main"
  const seen = new Set()
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i], value = argv[++i]
    if (seen.has(flag)) throw new BiblibError(EXIT.INVALID_ARGS, "argumentos", "Argumento repetido.")
    seen.add(flag)
    if (flag === "--as" && ["a", "b"].includes(value)) as = value
    else if (flag === "--profile" && ["main", "test", "scratch"].includes(value)) profile = value
    else throw new BiblibError(EXIT.INVALID_ARGS, "argumentos", "Uso: db:local:login --as a|b [--profile scratch].")
  }
  if (!as) throw new BiblibError(EXIT.INVALID_ARGS, "argumentos", "Indica --as a o --as b.")
  const fixture = await signInFixture(as, { profile })
  const app = getProfile(profile).app
  const cookieHeaders = fixture.cookies().map(({ name, value, options }) => serializeCookieHeader(name, value, options))
  const nonce = randomBytes(24).toString("hex")
  await new Promise((resolve, reject) => {
    let timer
    const server = createServer((request, response) => {
      const expected = `/${nonce}`
      const given = request.url ?? ""
      if (request.method !== "GET" || given.length !== expected.length || !timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
        response.writeHead(404, { "Cache-Control": "no-store" }); response.end(); return
      }
      response.writeHead(303, { "Set-Cookie": cookieHeaders, Location: `http://127.0.0.1:${app.port}/`, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" })
      response.end()
      clearTimeout(timer)
      server.close(() => resolve())
    })
    server.on("error", () => { clearTimeout(timer); reject(new BiblibError(EXIT.SERVICE_UNAVAILABLE, "sesión", "No se pudo abrir el acceso local temporal.")) })
    server.listen(0, "127.0.0.1", () => {
      console.log(`Acceso temporal del fixture ${as.toUpperCase()} (${profile}), válido una vez durante 2 minutos:`)
      console.log(`http://127.0.0.1:${server.address().port}/${nonce}`)
      console.log("Abre el enlace en el navegador local con dev:local en marcha; no compartas este enlace.")
      timer = setTimeout(() => server.close(() => resolve()), 120000)
    })
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await localLogin() } catch (error) {
    console.error(error instanceof BiblibError ? error.message : "No se pudo iniciar la sesión local.")
    process.exitCode = error instanceof BiblibError ? error.code : EXIT.VERIFICATION_FAILED
  }
}
