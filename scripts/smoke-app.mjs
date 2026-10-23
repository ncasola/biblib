/**
 * Smoke de producción aislado: node scripts/smoke-app.mjs [--artifacts=C:/ruta]
 * Requiere Docker, la imagen postgres:17-alpine, Chrome y dependencias instaladas.
 * Construye en un directorio temporal sin .env y usa exclusivamente Auth/DB de prueba.
 * No escribe en la base real ni en el build .next del repositorio.
 */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { createServer as createTcpServer } from "node:net"
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { randomUUID } from "node:crypto"

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const chromeBin = process.env.CHROME_BIN || (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : "/usr/bin/google-chrome")
const docker = process.platform === "win32" ? "docker.exe" : "docker"
const nextBin = path.join(repo, "node_modules/next/dist/bin/next")
const userId = "11111111-1111-4111-8111-111111111111"
const defaultShelfId = "22222222-2222-4222-8222-222222222222"
const shelfId = "33333333-3333-4333-8333-333333333333"
const secondShelfId = "55555555-5555-4555-8555-555555555555"
const initialBookId = "44444444-4444-4444-8444-444444444444"
const containerName = `biblib-smoke-${randomUUID().slice(0, 8)}`
const artifactsArg = process.argv.find((argument) => argument.startsWith("--artifacts="))?.slice("--artifacts=".length)
const artifacts = path.resolve(artifactsArg || path.join(tmpdir(), `biblib-smoke-results-${Date.now()}`))
const children = new Set()
const junctions = []
const checks = []
const record = (description) => { checks.push(description); console.log(`✓ ${description}`) }
const browserErrors = []
const blockedExternal = new Set()
let workspace, authServer, authOrigin, appOrigin, browserSocket, containerStarted = false, cleaned = false
let session, fixtureUser
let diagnosticBrowser
let outboundLog

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
function child(command, args, options = {}) {
  const processChild = spawn(command, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], ...options })
  children.add(processChild)
  processChild.once("close", () => children.delete(processChild))
  return processChild
}

async function command(commandName, args, input) {
  const processChild = child(commandName, args)
  let output = "", errors = ""
  processChild.stdout.on("data", (chunk) => { output += chunk })
  processChild.stderr.on("data", (chunk) => { errors += chunk })
  const complete = new Promise((resolve, reject) => {
    processChild.once("error", reject)
    processChild.once("close", (code) => code === 0 ? resolve(output.trim()) : reject(new Error(`${commandName} terminó con código ${code}: ${errors.slice(-4000) || output.slice(-4000)}`)))
  })
  processChild.stdin.end(input)
  return complete
}

async function stop(processChild) {
  if (processChild.exitCode !== null || processChild.killed) return
  if (process.platform === "win32") {
    await command("taskkill.exe", ["/pid", String(processChild.pid), "/t", "/f"]).catch(() => {})
  } else processChild.kill("SIGTERM")
}

async function cleanup() {
  if (cleaned) return
  cleaned = true
  browserSocket?.close()
  await Promise.all([...children].map(stop))
  if (authServer) await new Promise((resolve) => authServer.close(resolve))
  if (containerStarted) await command(docker, ["rm", "--force", containerName]).catch(() => {})
  if (workspace) {
    const resolved = await realpath(workspace)
    const temporaryRoot = await realpath(tmpdir())
    assert.ok(resolved.startsWith(`${temporaryRoot}${path.sep}`) && path.basename(resolved).startsWith("biblib-smoke-"), "El directorio de limpieza debe estar en la carpeta temporal de esta prueba.")
    for (const link of junctions) await unlink(link).catch(() => {})
    await rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void cleanup().finally(() => process.exit(130)) })

async function freePort() {
  const server = createTcpServer()
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function poll(operation, description, timeout = 15_000) {
  const deadline = Date.now() + timeout
  let lastError
  while (Date.now() < deadline) {
    try { const result = await operation(); if (result) return result } catch (error) { lastError = error }
    await delay(150)
  }
  throw new Error(`Tiempo agotado: ${description}${lastError ? ` (${lastError.message})` : ""}`)
}

function authReply(method, requestPath, headers, body = "") {
  const responseHeaders = { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": new Headers(headers).get("access-control-request-headers") || "authorization, apikey, content-type, x-client-info, x-supabase-api-version", "access-control-allow-methods": "GET, POST, PUT, OPTIONS" }
  if (method === "OPTIONS") return { status: 204, headers: responseHeaders, body: "" }
  const authorized = new Headers(headers).get("authorization") === `Bearer ${session.access_token}`
  if (requestPath === "/auth/v1/user" && authorized) {
    if (method === "PUT") {
      const payload = JSON.parse(body || "{}")
      fixtureUser = { ...fixtureUser, user_metadata: { ...fixtureUser.user_metadata, ...payload.data } }
      session.user = fixtureUser
    }
    return { status: 200, headers: responseHeaders, body: JSON.stringify(fixtureUser) }
  }
  if (requestPath === "/auth/v1/token" && method === "POST" && JSON.parse(body || "{}").refresh_token === session.refresh_token) return { status: 200, headers: responseHeaders, body: JSON.stringify(session) }
  if (requestPath === "/auth/v1/logout" && authorized) return { status: 204, headers: responseHeaders, body: "" }
  return { status: 401, headers: responseHeaders, body: JSON.stringify({ code: "invalid_credentials", msg: "Sesión de prueba no válida" }) }
}

async function startAuth() {
  authServer = createServer(async (request, response) => {
    let body = ""
    for await (const chunk of request) body += chunk
    const result = authReply(request.method, new URL(request.url, authOrigin).pathname, request.headers, body)
    response.writeHead(result.status, result.headers)
    response.end(result.body)
  })
  await new Promise((resolve) => authServer.listen(0, "127.0.0.1", resolve))
  authOrigin = `http://127.0.0.1:${authServer.address().port}`
  const expires = Math.floor(Date.now() / 1000) + 3600
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url")
  fixtureUser = { id: userId, aud: "authenticated", role: "authenticated", email: "lectora@example.invalid", email_confirmed_at: new Date().toISOString(), app_metadata: { provider: "google", providers: ["google"] }, user_metadata: { full_name: "Lectora de prueba" }, identities: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString(), is_anonymous: false }
  session = { access_token: `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: userId, role: "authenticated", aud: "authenticated", exp: expires, iss: `${authOrigin}/auth/v1` })}.smoke-signature`, refresh_token: "smoke-refresh-token", token_type: "bearer", expires_at: expires, expires_in: 3600, user: fixtureUser }
}

async function sql(text) {
  return command(docker, ["exec", "-i", containerName, "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "biblib_smoke", "-At"], text)
}

async function prepareDatabase() {
  const password = randomUUID()
  await command(docker, ["run", "--detach", "--rm", "--name", containerName, "--label", "biblib.test=smoke", "--publish", "127.0.0.1::5432", "--env", `POSTGRES_PASSWORD=${password}`, "--env", "POSTGRES_DB=biblib_smoke", "postgres:17-alpine"])
  containerStarted = true
  await poll(() => command(docker, ["exec", containerName, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"]).then(() => true).catch(() => false), "Postgres de prueba", 30_000)
  for (const file of ["tests/db/bootstrap.sql", "drizzle/0000_biblib_init.sql", "drizzle/0001_library_integrity.sql", "drizzle/0002_book_versions.sql", "drizzle/0003_library_revision.sql"]) await sql(await readFile(path.join(repo, file), "utf8"))
  await sql(`INSERT INTO auth.users(id) VALUES ('${userId}');
    INSERT INTO biblib.shelves(id,user_id,title,is_default) VALUES ('${defaultShelfId}','${userId}','Predeterminada',true),('${shelfId}','${userId}','Ensayo',false),('${secondShelfId}','${userId}','Narrativa',false);
    INSERT INTO biblib.books(id,user_id,isbn,title,authors,number_of_pages,status,shelf_id) VALUES ('${initialBookId}','${userId}','manual-${initialBookId}','Libro inicial de prueba','[{"name":"Autora inicial"}]',100,'unread','${defaultShelfId}');`)
  const published = await command(docker, ["port", containerName, "5432/tcp"])
  const port = Number(published.match(/127\.0\.0\.1:(\d+)/)?.[1])
  assert.ok(port, "Puerto de Postgres publicado únicamente en loopback")
  return `postgres://postgres:${password}@127.0.0.1:${port}/biblib_smoke`
}

async function prepareApp(dbUrl) {
  workspace = await mkdtemp(path.join(tmpdir(), "biblib-smoke-"))
  // `scripts` (next.config.mjs) y `tests/fixtures` (lib/catalogue-fixtures.ts) son importados por la app.
  for (const directory of ["app", "components", "hooks", "lib", "public", "scripts", "tests/fixtures", "node_modules"]) {
    const target = path.join(workspace, directory)
    await mkdir(path.dirname(target), { recursive: true })
    await symlink(path.join(repo, directory), target, process.platform === "win32" ? "junction" : "dir")
    junctions.push(target)
  }
  for (const file of ["package.json", "next.config.mjs", "postcss.config.mjs", "tsconfig.json", "next-env.d.ts", "proxy.ts"]) {
    await copyFile(path.join(repo, file), path.join(workspace, file))
  }
  // Solo se hereda el entorno del proceso; las tres conexiones de la app son fixtures.
  const env = { ...process.env, NEXT_PUBLIC_SUPABASE_URL: authOrigin, NEXT_PUBLIC_SUPABASE_ANON_KEY: "smoke-anon-key", SUPABASE_DB_URL: dbUrl, NEXT_TELEMETRY_DISABLED: "1", NODE_ENV: "production" }
  console.log("Construyendo BibLib en carpeta temporal sin archivos .env…")
  const build = child(process.execPath, [nextBin, "build", workspace, "--webpack"], { cwd: workspace, env })
  let buildOutput = ""
  for (const stream of [build.stdout, build.stderr]) stream.on("data", (chunk) => { buildOutput += chunk })
  const buildCode = await new Promise((resolve, reject) => { build.once("error", reject); build.once("close", resolve) })
  await writeFile(path.join(artifacts, "build.log"), buildOutput)
  assert.equal(buildCode, 0, `El build aislado debe terminar correctamente. Véase ${path.join(artifacts, "build.log")}`)
  const port = await freePort()
  appOrigin = `http://127.0.0.1:${port}`
  // Instrumentación exclusiva del proceso de prueba: ningún fetch del servidor sale a Internet.
  outboundLog = path.join(workspace, "outbound.jsonl")
  await writeFile(outboundLog, "")
  const preload = path.join(workspace, "smoke-network.mjs")
  await writeFile(preload, `import { appendFile } from 'node:fs/promises';
const originalFetch = globalThis.fetch;
globalThis.fetch = async function(input, init) {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    await appendFile(${JSON.stringify(outboundLog)}, JSON.stringify({url:url.href}) + '\\n');
    throw new Error('La prueba aislada bloquea solicitudes externas');
  }
  return originalFetch(input, init);
};\n`)
  const app = child(process.execPath, ["--import", pathToFileURL(preload).href, nextBin, "start", workspace, "--hostname", "127.0.0.1", "--port", String(port)], { cwd: workspace, env })
  let appOutput = ""
  for (const stream of [app.stdout, app.stderr]) stream.on("data", (chunk) => { appOutput += chunk })
  app.once("close", () => { void writeFile(path.join(artifacts, "server.log"), appOutput) })
  await poll(async () => { const response = await fetch(`${appOrigin}/login`); return response.status === 200 }, "arranque de BibLib", 30_000)
}

class Cdp {
  constructor(socket) {
    this.socket = socket
    this.nextId = 0
    this.pending = new Map()
    this.handlers = new Map()
    socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(data)
      if (message.id) {
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        clearTimeout(pending.timeout)
        if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result)
      } else {
        for (const callback of this.handlers.get(message.method) || []) void Promise.resolve(callback(message.params)).catch((error) => browserErrors.push(error.message))
      }
    })
    socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) { clearTimeout(pending.timeout); pending.reject(new Error("Chrome cerró la conexión CDP")) }
      this.pending.clear()
    })
  }
  on(event, callback) { const callbacks = this.handlers.get(event) || []; callbacks.push(callback); this.handlers.set(event, callbacks) }
  call(method, params = {}) {
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP agotado: ${method}`)) }, 20_000)
      this.pending.set(id, { resolve, reject, timeout })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }
  async evaluate(expression) {
    const result = await this.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result.value
  }
}

async function startBrowser() {
  const profile = await mkdtemp(path.join(workspace, "chrome-"))
  const chrome = child(chromeBin, ["--headless=new", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "about:blank"])
  chrome.stdout.resume(); chrome.stderr.resume()
  const active = await poll(async () => { const text = await readFile(path.join(profile, "DevToolsActivePort"), "utf8"); return Number(text.split("\n")[0]) }, "Chrome headless", 20_000)
  const target = await (await fetch(`http://127.0.0.1:${active}/json/new?about:blank`, { method: "PUT" })).json()
  browserSocket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { browserSocket.addEventListener("open", resolve, { once: true }); browserSocket.addEventListener("error", reject, { once: true }) })
  const cdp = new Cdp(browserSocket)
  cdp.on("Runtime.exceptionThrown", ({ exceptionDetails }) => browserErrors.push(exceptionDetails.exception?.description || exceptionDetails.text))
  cdp.on("Runtime.consoleAPICalled", ({ type, args }) => { if (type === "error" && args.some((entry) => /hydration|hydrating|React error|Minified React/i.test(entry.value || entry.description || ""))) browserErrors.push(args.map((entry) => entry.value || entry.description).join(" ")) })
  cdp.on("Fetch.requestPaused", async ({ requestId, request }) => {
    const url = new URL(request.url)
    if ([appOrigin, authOrigin].includes(url.origin) || ["data:", "blob:"].includes(url.protocol)) await cdp.call("Fetch.continueRequest", { requestId })
    else {
      blockedExternal.add(url.origin)
      await cdp.call("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" })
    }
  })
  for (const method of ["Page.enable", "Runtime.enable", "Network.enable"]) await cdp.call(method)
  await cdp.call("Fetch.enable", { patterns: [{ urlPattern: "*" }] })
  return cdp
}

async function browserChecks(cdp) {
  const evaluate = (expression) => cdp.evaluate(expression)
  const wait = (expression, description) => poll(() => evaluate(expression), description)
  const navigate = async (route, ready) => {
    await cdp.call("Page.navigate", { url: `${appOrigin}${route}` })
    await wait(`document.readyState === 'complete' && (${ready})`, route)
    await delay(300)
  }
  const click = async (label, within = "document") => {
    const point = await evaluate(`(() => { const element = [...${within}.querySelectorAll('button,a')].find((element) => element.textContent.trim() === ${JSON.stringify(label)} && element.getClientRects().length); if (!element) throw new Error('Control no encontrado: ' + ${JSON.stringify(label)}); if (element.disabled) throw new Error('Control deshabilitado: ' + ${JSON.stringify(label)}); element.scrollIntoView({block:'center'}); const rect=element.getBoundingClientRect(); return {x:rect.x+rect.width/2,y:rect.y+rect.height/2} })()`)
    await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 })
    await cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 })
  }
  const field = async (label, value) => {
    await evaluate(`(() => { const label = [...document.querySelectorAll('label')].find((element) => element.textContent.replace('*','').trim() === ${JSON.stringify(label)}); const element = label && document.getElementById(label.htmlFor); if (!element) throw new Error('Campo no encontrado: ' + ${JSON.stringify(label)}); const prototype = element.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype,'value').set.call(element,${JSON.stringify(value)}); element.dispatchEvent(new Event('input',{bubbles:true})); element.dispatchEvent(new Event('change',{bubbles:true})); return true })()`)
  }
  const screenshot = async (name) => { const result = await cdp.call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }); await writeFile(path.join(artifacts, name), Buffer.from(result.data, "base64")) }

  await navigate("/login?error=oauth", "document.body.innerText.includes('No se pudo completar el acceso')")
  await evaluate("localStorage.setItem('theme','dark')")
  await navigate("/login", "document.body.innerText.includes('Continuar con Google')")
  await wait("document.documentElement.classList.contains('dark') && getComputedStyle(document.documentElement).colorScheme === 'dark'", "tema global oscuro")
  await cdp.call("Emulation.setDeviceMetricsOverride", { width: 375, height: 812, deviceScaleFactor: 1, mobile: false })
  assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true, "Acceso móvil sin desbordamiento")
  await screenshot("login-mobile.png")
  record("Login móvil y tema oscuro, sin errores de hidratación")

  const cookieValue = `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`
  await cdp.call("Network.setCookie", { name: "sb-127-auth-token", value: cookieValue, url: appOrigin, path: "/", sameSite: "Lax" })
  await cdp.call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  await navigate("/", "document.body.innerText.includes('Libro inicial de prueba')")
  assert.equal(await evaluate("document.querySelectorAll('a button').length"), 0, "Sin botones anidados en enlaces")
  record("Inicio privado con datos de Postgres aislado")

  await navigate("/books/add", "document.body.innerText.includes('Buscar libro')")
  await click("Entrada manual")
  await wait("[...document.querySelectorAll('label')].some(label => label.textContent.replace('*','').trim() === 'Título')", "formulario manual")
  await field("Título", "Prueba humo: alta manual")
  await field("Autor 1", "Autora, Nombre")
  await field("Editorial 1", "Editorial de prueba")
  await field("Número de páginas", "223")
  await field("Estantería", shelfId)
  await click("Agregar a la biblioteca")
  await wait("document.querySelector('h1')?.textContent === 'Prueba humo: alta manual'", "alta manual")
  const createdBookId = await evaluate("location.pathname.split('/').at(-1)")
  assert.match(createdBookId, /^[0-9a-f-]{36}$/)
  assert.equal(await sql(`SELECT count(*) FROM biblib.books WHERE id='${createdBookId}' AND shelf_id='${shelfId}';`), "1")

  await click("Editar ficha")
  await wait("document.querySelector('h1')?.textContent === 'Editar ficha'", "edición de libro")
  await field("Título", "Borrador conservado por conflicto")
  await sql(`UPDATE biblib.books SET subtitle='Actualizado desde otra sesión de prueba' WHERE id='${createdBookId}';`)
  await click("Guardar cambios")
  await wait("document.body.innerText.includes('Descartar formulario y cargar versión actual')", "conflicto concurrente recuperable")
  assert.equal(await evaluate("[...document.querySelectorAll('label')].find((element) => element.textContent.replace('*','').trim() === 'Título').control.value"), "Borrador conservado por conflicto", "El conflicto conserva el borrador")
  assert.equal(await sql(`SELECT title FROM biblib.books WHERE id='${createdBookId}';`), "Prueba humo: alta manual", "El conflicto no sobrescribe datos")
  await click("Descartar formulario y cargar versión actual")
  await wait("[...document.querySelectorAll('label')].find((element) => element.textContent.trim() === 'Subtítulo')?.control?.value === 'Actualizado desde otra sesión de prueba'", "recarga explícita de la versión actual")
  record("Conflicto concurrente conserva borrador y DB, permite recarga explícita")
  await field("Título", "Prueba humo: ficha editada")
  await field("Número de páginas", "321")
  await field("ISBN", "9780747532699")
  await field("Estantería", secondShelfId)
  await evaluate("document.querySelector('input[type=checkbox]').click()")
  await click("Guardar cambios")
  await wait("document.querySelector('h1')?.textContent === 'Prueba humo: ficha editada'", "guardado de edición")
  assert.equal(await sql(`SELECT count(*) FROM biblib.books WHERE id='${createdBookId}' AND number_of_pages=321 AND shelf_id='${secondShelfId}' AND authors->0->>'name'='Autora, Nombre' AND catalogue->>'isbnVerified'='true';`), "1")
  await field("Estantería", shelfId)
  await click("Mover libro")
  await wait("document.body.innerText.includes('Ubicación actualizada.')", "movimiento de estantería")
  await click("Leyendo")
  await wait("document.body.innerText.includes('Estado de lectura actualizado.')", "cambio de estado")
  assert.equal(await sql(`SELECT count(*) FROM biblib.books WHERE id='${createdBookId}' AND status='reading' AND shelf_id='${shelfId}';`), "1")
  record("Alta, edición completa, autores con coma, verificación ISBN, ubicación y estado")
  await screenshot("book-detail-desktop.png")

  await navigate("/books/add", "document.body.innerText.includes('Buscar libro')")
  await field("Número ISBN", "0-7475-3269-9")
  await click("Buscar libro")
  await wait("document.body.innerText.includes('Este libro ya está en tu biblioteca')", "ISBN equivalente ya catalogado")
  assert.equal(await evaluate(`Boolean(document.querySelector('a[href="/book/${createdBookId}"]'))`), true)
  record("ISBN-10 con guiones detecta libro existente y conserva enlace")

  const importedId = "66666666-6666-4666-8666-666666666666"
  const importPath = path.join(workspace, "smoke-import.json")
  await writeFile(importPath, JSON.stringify({ shelves: [{ id: "smoke-import", title: "Importación de prueba", book_count: 1 }], books: [{ id: importedId, isbn: `manual-${importedId}`, title: "Libro importado de prueba", authors: [], number_of_pages: 0, publish_date: "", cover: { small: "/default-book-cover.webp", medium: "/default-book-cover.webp", large: "/default-book-cover.webp" }, status: "unread", shelf_id: "smoke-import", shelf_name: "Importación de prueba" }] }))
  await navigate("/settings", "document.querySelector('#import-file') && !document.querySelector('#import-file').disabled")
  const downloads = path.join(workspace, "downloads")
  await mkdir(downloads)
  await cdp.call("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads })
  await click("Descargar copia de seguridad")
  const downloaded = await poll(async () => (await readdir(downloads)).find((file) => file.endsWith(".json")), "descarga JSON de seguridad")
  const backup = JSON.parse(await readFile(path.join(downloads, downloaded), "utf8"))
  assert.equal(backup.formatVersion, 1)
  assert.equal(backup.books.length, 2)
  assert.ok(backup.books.some((book) => book.id === createdBookId && book.catalogue.isbnVerified))
  assert.ok(backup.books.some((book) => book.id === initialBookId))
  await copyFile(path.join(downloads, downloaded), path.join(artifacts, "fixture-backup.json"))
  record("Exportación descarga JSON versionado con datos actuales y verificación ISBN")
  const { root } = await cdp.call("DOM.getDocument")
  const { nodeId } = await cdp.call("DOM.querySelector", { nodeId: root.nodeId, selector: "#import-file" })
  await cdp.call("DOM.setFileInputFiles", { nodeId, files: [importPath] })
  await wait("document.body.innerText.includes('Revisión: smoke-import.json')", "previsualización de importación")
  assert.equal(await sql("SELECT count(*) FROM biblib.books;"), "2", "La selección del archivo no escribe datos")
  await screenshot("import-preview.png")
  await click("Continuar y confirmar")
  await wait("Boolean(document.querySelector('[role=alertdialog]'))", "confirmación de importación")
  await click("Sí, fusionar biblioteca", "document.querySelector('[role=alertdialog]')")
  await wait("document.body.innerText.includes('Resultado de la importación')", "resultado de fusión")
  assert.equal(await sql("SELECT count(*) FROM biblib.books;"), "3", "Fusionar conserva los dos libros anteriores")
  record("Importación: revisión sin escrituras, confirmación y fusión aditiva")

  await navigate(`/book/${createdBookId}`, "document.querySelector('h1')?.textContent === 'Prueba humo: ficha editada'")
  await click("Eliminar libro")
  await wait("Boolean(document.querySelector('[role=alertdialog]'))", "confirmación de eliminación")
  assert.equal(await sql("SELECT count(*) FROM biblib.books;"), "3", "Abrir confirmación no elimina datos")
  await click("Eliminar libro", "document.querySelector('[role=alertdialog]')")
  await wait("location.pathname === '/books'", "eliminación completada")
  assert.equal(await sql(`SELECT count(*) FROM biblib.books WHERE id='${createdBookId}';`), "0")
  record("Eliminación confirmada sin afectar otros libros")

  await navigate("/settings", "document.querySelector('#import-file') && !document.querySelector('#import-file').disabled")
  await click("Recuperar portadas pendientes")
  await wait("document.body.innerText.includes('Búsqueda terminada. Las portadas encontradas ya están guardadas.')", "recuperación de portadas sin ISBN")
  assert.deepEqual(await evaluate("[...document.querySelector('[aria-labelledby=covers-title]').querySelectorAll('dl > div')].map((element) => [element.querySelector('dt').textContent, element.querySelector('dd').textContent])"), [["Revisados", "2"], ["Portadas recuperadas", "0"], ["Sin resultado", "0"], ["Omitidos", "2"]])
  assert.equal(await readFile(outboundLog, "utf8"), "", "La colección sin ISBN no genera solicitudes HTTP externas")
  record("Recuperación de portadas omite manuales sin ISBN y no realiza HTTP externo")
  await evaluate("document.querySelector('[aria-labelledby=covers-title]').scrollIntoView({block:'center'})")
  await delay(150)
  await screenshot("cover-recovery.png")

  const retainedIds = (await sql("SELECT id::text FROM biblib.books ORDER BY id;")).split("\n")
  assert.equal(retainedIds.length, 2)
  const fixturePrefix = "77777777-7777-4777-8777-"
  await sql(`INSERT INTO biblib.books(id,user_id,isbn,title,authors,status,shelf_id)
    SELECT fixture_id::uuid,'${userId}','manual-' || fixture_id,'Lote exportación ' || sequence,'[]'::jsonb,'unread','${defaultShelfId}'
    FROM (SELECT sequence, '${fixturePrefix}' || lpad(sequence::text,12,'0') AS fixture_id FROM generate_series(1,1999) AS sequence) AS fixtures;`)
  try {
    const multipartDownloads = path.join(workspace, "multipart-downloads")
    await mkdir(multipartDownloads)
    await cdp.call("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: multipartDownloads })
    await click("Descargar copia de seguridad")
    await wait("document.body.innerText.includes('Copia dividida en 2 archivos importables')", "exportación multipart")
    const labels = await evaluate("[...document.querySelectorAll('button')].map(element => element.textContent.trim()).filter(text => text.startsWith('Descargar parte '))")
    assert.equal(labels.length, 2)
    assert.match(labels[0], /Descargar parte 1 de 2.*2000 libros/)
    assert.match(labels[1], /Descargar parte 2 de 2.*1 libros/)
    await screenshot("export-multipart.png")
    for (const label of labels) await click(label)
    const files = await poll(async () => { const files = (await readdir(multipartDownloads)).filter((file) => file.endsWith(".json")); return files.length === 2 ? files.sort() : false }, "descarga de ambas partes JSON")
    const parts = []
    for (let index = 0; index < files.length; index++) {
      const raw = await readFile(path.join(multipartDownloads, files[index]))
      assert.ok(raw.byteLength <= 8 * 1024 * 1024, "Cada parte respeta el límite de 8 MiB")
      const part = JSON.parse(raw.toString("utf8"))
      assert.equal(part.formatVersion, 1)
      assert.ok(part.books.length <= 2000 && part.shelves.length <= 200)
      assert.ok(Number.isFinite(Date.parse(part.exportedAt)))
      const shelvesById = new Map(part.shelves.map((shelf) => [shelf.id, shelf]))
      const counts = new Map()
      for (const book of part.books) {
        assert.ok(shelvesById.has(book.shelf_id), "Cada libro conserva una estantería incluida en su parte")
        assert.equal(book.shelf_name, shelvesById.get(book.shelf_id).title)
        counts.set(book.shelf_id, (counts.get(book.shelf_id) ?? 0) + 1)
      }
      for (const shelf of part.shelves) assert.equal(shelf.book_count, counts.get(shelf.id) ?? 0, "Recuentos coherentes con los libros de cada parte")
      parts.push(part)
      await copyFile(path.join(multipartDownloads, files[index]), path.join(artifacts, `multipart-${index + 1}.json`))
    }
    assert.equal(new Set(parts.map((part) => part.exportedAt)).size, 1, "Las partes comparten fecha de exportación")
    const exportedBooks = parts.flatMap((part) => part.books)
    const uniqueIds = new Set(exportedBooks.map((book) => book.id))
    assert.equal(exportedBooks.length, 2001)
    assert.equal(uniqueIds.size, 2001)
    for (const id of retainedIds) assert.ok(uniqueIds.has(id), "Se conservan los libros anteriores al lote")
    assert.ok(exportedBooks.some((book) => book.id === initialBookId))
    assert.ok(exportedBooks.some((book) => book.isbn === `manual-${importedId}`))
    const exportedShelfIds = [...new Set(parts.flatMap((part) => part.shelves.map((shelf) => shelf.id)))].sort()
    assert.deepEqual(exportedShelfIds, (await sql("SELECT id::text FROM biblib.shelves ORDER BY id;")).split("\n"))
    record("Exportación de 2001 libros descarga dos partes importables, sin pérdidas ni duplicados")
  } finally {
    await sql(`DELETE FROM biblib.books WHERE user_id='${userId}' AND id::text LIKE '${fixturePrefix}%';`)
  }
  assert.deepEqual((await sql("SELECT id::text FROM biblib.books ORDER BY id;")).split("\n"), retainedIds, "La limpieza solo elimina los fixtures adicionales")

  await navigate("/profile", "document.querySelector('#name')?.value === 'Lectora de prueba'")
  await field("Nombre", "Lectora actualizada")
  await click("Guardar cambios")
  await wait("document.body.innerText.includes('Perfil actualizado correctamente.')", "perfil persistido en Auth mock")
  assert.equal(fixtureUser.user_metadata.display_name, "Lectora actualizada")
  record("Perfil guarda nombre en Auth y muestra confirmación real")
  await navigate("/books", "document.body.innerText.includes('Libro inicial de prueba')")
  await cdp.call("Emulation.setDeviceMetricsOverride", { width: 375, height: 812, deviceScaleFactor: 1, mobile: false })
  await delay(250)
  assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true, "Colección móvil sin desbordamiento")
  await screenshot("books-mobile.png")
  assert.deepEqual(browserErrors, [], "Sin excepciones JavaScript ni errores de hidratación")
}

try {
  await access(chromeBin)
  await access(nextBin)
  assert.equal(typeof WebSocket, "function", "Se requiere Node con WebSocket integrado")
  await mkdir(artifacts, { recursive: true })
  const dbUrl = await prepareDatabase()
  await startAuth()
  await prepareApp(dbUrl)
  for (const route of ["/", `/book/${initialBookId}`]) {
    const response = await fetch(`${appOrigin}${route}`, { redirect: "manual" })
    assert.equal(response.status, 307)
    assert.equal(new URL(response.headers.get("location"), appOrigin).pathname, "/login")
  }
  for (const next of ["https://example.invalid", "//example.invalid", "/\\example.invalid"]) {
    const response = await fetch(`${appOrigin}/auth/callback?next=${encodeURIComponent(next)}`, { redirect: "manual" })
    const destination = new URL(response.headers.get("location"), appOrigin)
    assert.equal(destination.origin, appOrigin)
    assert.equal(destination.pathname, "/login")
    assert.equal(destination.searchParams.get("error"), "oauth")
  }
  const login = await fetch(`${appOrigin}/login`)
  assert.equal(login.headers.get("x-content-type-options"), "nosniff")
  record("Proxy protege inicio/detalle; callback rechaza destinos externos y conserva error OAuth")
  const cdp = await startBrowser()
  diagnosticBrowser = cdp
  await browserChecks(cdp)
  await writeFile(path.join(artifacts, "report.json"), JSON.stringify({ ok: true, checks, browserErrors, blockedExternal: [...blockedExternal], isolation: "Build temporal sin .env, Auth mock en loopback y Postgres Docker efímero; sin credenciales reales." }, null, 2))
  console.log(JSON.stringify({ ok: true, checks, artifacts }, null, 2))
} catch (error) {
  await mkdir(artifacts, { recursive: true })
  const pageText = diagnosticBrowser ? await diagnosticBrowser.evaluate("document.body.innerText").catch(() => "") : ""
  if (diagnosticBrowser) {
    const screenshot = await diagnosticBrowser.call("Page.captureScreenshot", { format: "png" }).catch(() => null)
    if (screenshot) await writeFile(path.join(artifacts, "failure.png"), Buffer.from(screenshot.data, "base64"))
  }
  await writeFile(path.join(artifacts, "report.json"), JSON.stringify({ ok: false, error: error.message, checks, browserErrors, blockedExternal: [...blockedExternal], pageText }, null, 2))
  console.error(`Smoke fallido: ${error.message}\nArtefactos: ${artifacts}`)
  process.exitCode = 1
} finally {
  await cleanup()
}
