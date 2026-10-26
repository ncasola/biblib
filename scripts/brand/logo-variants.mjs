// Genera variantes del logo de BibLib a partir de public/logo.png (fondo blanco opaco).
// Uso: node scripts/brand/logo-variants.mjs [public/logo.png] [public]
import path from "node:path"
import sharp from "sharp"

const [input = "public/logo.png", outDir = "public"] = process.argv.slice(2)

// Blancura de un píxel: 0 = color pleno, 1 = blanco puro.
const whiteness = (r, g, b) => Math.min(r, g, b) / 255
const NEAR_WHITE = 0.92
// Solo los píxeles así de cerca del blanco se tratan como mezcla de borde; un color claro (el oliva de «LIB») no.
const BLEND = 0.3

async function main() {
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const { width: w, height: h } = info
  const at = (x, y) => (y * w + x) * 4

  const isWhite = (x, y) => { const i = at(x, y); return whiteness(data[i], data[i + 1], data[i + 2]) >= NEAR_WHITE }
  const dilate = (mask, r) => {
    const outMask = new Uint8Array(w * h)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const nx = x + dx, ny = y + dy
        if (nx >= 0 && ny >= 0 && nx < w && ny < h && dx * dx + dy * dy <= r * r) outMask[ny * w + nx] = 1
      }
    }
    return outMask
  }
  const flood = (seeds, passable) => {
    const region = new Uint8Array(w * h)
    const stack = [...seeds]
    while (stack.length) {
      const [x, y] = stack.pop()
      if (x < 0 || y < 0 || x >= w || y >= h || region[y * w + x] || !passable(x, y)) continue
      region[y * w + x] = 1
      stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1])
    }
    return region
  }

  // 1. Fondo = blanco conectado con el borde, pero sin colarse por los huecos de la silueta (páginas abiertas,
  // finales de línea): se rellena contra la silueta engordada SEAL px y luego se recuperan esos SEAL px de blanco.
  const SEAL = 4
  const ink = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) ink[y * w + x] = isWhite(x, y) ? 0 : 1
  const wall = dilate(ink, SEAL)
  const border = []
  for (let x = 0; x < w; x++) border.push([x, 0], [x, h - 1])
  for (let y = 0; y < h; y++) border.push([0, y], [w - 1, y])
  const outside = flood(border, (x, y) => !wall[y * w + x])
  // Recuperación acotada: solo por blanco contiguo y como mucho SEAL + 1 pasos desde el exterior, así que nunca
  // atraviesa un contorno (guantes, ojos) ni entra más que unos píxeles por una página abierta.
  const background = Uint8Array.from(outside)
  let frontier = []
  for (let p = 0; p < w * h; p++) if (outside[p]) frontier.push(p)
  for (let step = 0; step <= SEAL; step++) {
    const next = []
    for (const p of frontier) {
      const x = p % w, y = (p - x) / w
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
        const q = ny * w + nx
        if (background[q] || ink[q]) continue
        background[q] = 1
        next.push(q)
      }
    }
    frontier = next
  }

  // 2. Fondo transparente y borde suavizado: la franja de EDGE px junto al fondo pierde la mezcla con el blanco.
  const EDGE = 2
  const near = dilate(background, EDGE)
  const out = Buffer.from(data)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = at(x, y)
    if (background[y * w + x]) { out[i + 3] = 0; continue }
    if (!near[y * w + x]) continue
    const a = 1 - whiteness(data[i], data[i + 1], data[i + 2])
    if (a >= BLEND) continue
    const alpha = Math.max(0.04, Math.min(1, a / BLEND))
    // Des-mezcla con blanco: c = (c' - 255·(1-α)) / α
    for (let k = 0; k < 3; k++) out[i + k] = Math.max(0, Math.min(255, Math.round((data[i + k] - 255 * (1 - alpha)) / alpha)))
    out[i + 3] = Math.round(alpha * 255)
  }
  // La franja del nombre «BIBLIB» solo contiene letras: su blanco interior (muescas de la tipografía) también es hueco.
  for (let y = Math.round(h * 0.76); y < Math.round(h * 0.895); y++) for (let x = 0; x < w; x++) {
    const i = at(x, y)
    if (out[i + 3] === 0) continue
    const a = 1 - whiteness(data[i], data[i + 1], data[i + 2])
    if (a >= BLEND) continue
    const alpha = Math.max(0, Math.min(1, a / BLEND))
    if (alpha < 0.04) { out[i + 3] = 0; continue }
    for (let k = 0; k < 3; k++) out[i + k] = Math.max(0, Math.min(255, Math.round((data[i + k] - 255 * (1 - alpha)) / alpha)))
    out[i + 3] = Math.round(alpha * 255)
  }

  const raw = { raw: { width: w, height: h, channels: 4 } }
  await sharp(out, raw).png({ compressionLevel: 9 }).toFile(path.join(outDir, "logo-transparent.png"))

  // 3. Variante para fondo oscuro: el texto «BOOK MANAGER» (casi negro, franja inferior) pasa a crema.
  const dark = Buffer.from(out)
  const cream = [0xf6, 0xed, 0xdd]
  const textTop = Math.round(h * 0.89)
  // Cobertura del texto = cuánto se aleja del blanco en el original; con ella como alfa no queda halo.
  for (let y = textTop; y < h; y++) for (let x = 0; x < w; x++) {
    const i = at(x, y)
    if (dark[i + 3] === 0) continue
    const lum = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
    const coverage = Math.min(1, (1 - lum / 255) * 1.1)
    dark[i] = cream[0]; dark[i + 1] = cream[1]; dark[i + 2] = cream[2]
    dark[i + 3] = Math.round(coverage * 255)
  }
  await sharp(dark, raw).png({ compressionLevel: 9 }).toFile(path.join(outDir, "logo-dark.png"))

  // 4. Solo el personaje (sin las letras), recortado a su caja y cuadrado, para la cabecera y el favicon.
  const markBottom = Math.round(h * 0.75)
  const mark = await sharp(out, raw).extract({ left: 0, top: 0, width: w, height: markBottom }).png().toBuffer()
  const trimmed = await sharp(mark).trim({ threshold: 1 }).toBuffer({ resolveWithObject: true })
  const side = Math.max(trimmed.info.width, trimmed.info.height)
  await sharp(trimmed.data).extend({
    top: Math.floor((side - trimmed.info.height) / 2), bottom: Math.ceil((side - trimmed.info.height) / 2),
    left: Math.floor((side - trimmed.info.width) / 2), right: Math.ceil((side - trimmed.info.width) / 2),
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  }).png({ compressionLevel: 9 }).toFile(path.join(outDir, "logo-mark.png"))
  console.log("ok", w, h, "mark", side)
}

main().catch((error) => { console.error(error); process.exit(1) })
