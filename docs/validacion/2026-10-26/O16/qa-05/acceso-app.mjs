// Recorrido HTTP mínimo de la app del perfil scratch con sesiones GoTrue reales (U-QA-05, O16).
// No imprime cookies, tokens ni contraseñas: solo rutas, códigos y marcadores.
// Uso: node docs/validacion/2026-10-26/O16/qa-05/acceso-app.mjs
import { signInFixture } from "../../../../../tests/integration/support/session.mjs"

const BASE = "http://127.0.0.1:3149"
const ROUTES = ["/", "/books", "/books/add", "/books/search", "/shelves", "/shelves/3d", "/settings", "/locations", "/series", "/loans", "/profile", "/books/review", "/offline"]

async function get(path, cookie) {
  const response = await fetch(`${BASE}${path}`, { redirect: "manual", headers: cookie ? { cookie } : {} })
  const body = response.status === 200 ? await response.text() : ""
  return { path, status: response.status, location: response.headers.get("location") ?? "", hasBibLib: body.includes("BibLib"), hydrationMarker: body.includes("__next") || body.includes("self.__next_f") }
}

const results = { anonymous: [], a: [], b: [] }
results.anonymous.push(await get("/login"))
results.anonymous.push(await get("/books"))
for (const as of ["a", "b"]) {
  const { cookies, client } = await signInFixture(as, { profile: "scratch" })
  const cookie = cookies().filter((entry) => entry.value).map((entry) => `${entry.name}=${entry.value}`).join("; ")
  for (const route of ROUTES) results[as].push(await get(route, cookie))
  await client.auth.signOut()
}
const failures = [
  ...results.anonymous.filter((entry) => (entry.path === "/login" ? entry.status !== 200 : !(entry.status >= 300 && entry.status < 400 && entry.location.includes("/login")))),
  ...results.a.filter((entry) => entry.status !== 200),
  ...results.b.filter((entry) => entry.status !== 200),
]
console.log(JSON.stringify({ base: BASE, results, failures: failures.length }, null, 2))
process.exitCode = failures.length ? 1 : 0
