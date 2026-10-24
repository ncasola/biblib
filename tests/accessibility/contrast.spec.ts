import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { expect, test } from "../e2e/lib/fixtures"

test("contraste: colores compuestos, estados, componentes y foco en ambos temas", async ({ page }, info) => {
  await page.goto("/books")
  await page.waitForLoadState("networkidle")
  const results = []
  for (const theme of ["light", "dark"]) {
    await page.evaluate((theme) => document.documentElement.classList.toggle("dark", theme === "dark"), theme)
    const rows = await page.evaluate(() => {
      type Color = [number, number, number, number]
      const canvas = document.createElement("canvas")
      canvas.width = canvas.height = 1
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!
      const color = (value: string): Color => {
        ctx.clearRect(0, 0, 1, 1)
        ctx.fillStyle = value
        ctx.fillRect(0, 0, 1, 1)
        const pixel = ctx.getImageData(0, 0, 1, 1).data
        return [pixel[0], pixel[1], pixel[2], pixel[3] / 255]
      }
      const composite = (front: Color, back: Color): Color => [front[0] * front[3] + back[0] * (1 - front[3]), front[1] * front[3] + back[1] * (1 - front[3]), front[2] * front[3] + back[2] * (1 - front[3]), 1]
      const luminance = (rgb: Color) => rgb.slice(0, 3).map((byte) => { const value = byte / 255; return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4 }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0)
      const contrast = (a: Color, b: Color) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05)
      const container = document.createElement("div")
      container.className = "bg-background"
      container.style.position = "fixed"
      container.style.inset = "0"
      document.body.append(container)
      const base = color(getComputedStyle(container).backgroundColor)
      const measurements: { name: string; foreground: Color; background: Color; ratio: number; minimum: number }[] = []
      const samples = [
        ["texto / fondo", "bg-background text-foreground"],
        ["secundario / tarjeta 80 %", "bg-card/80 text-muted-foreground"],
        ["texto / tarjeta 80 %", "bg-card/80 text-card-foreground"],
        ["rojo / tarjeta 80 %", "bg-card/80 text-vintage-red"],
        ["oliva / tarjeta 80 %", "bg-card/80 text-vintage-olive"],
        ["amarillo / tarjeta 80 %", "bg-card/80 text-vintage-yellow"],
        ["morado / tarjeta 80 %", "bg-card/80 text-vintage-purple"],
        ["marrón / tarjeta 80 %", "bg-card/80 text-vintage-brown"],
        ["primario", "bg-primary text-primary-foreground"],
        ["rojo de marca", "bg-vintage-red text-white"],
        ["primario hover", "bg-primary/90 text-primary-foreground"],
        ["secundario", "bg-secondary text-secondary-foreground"],
        ["secundario hover", "bg-secondary/80 text-secondary-foreground"],
        ["destructivo", "bg-destructive text-destructive-foreground"],
        ["destructivo hover", "bg-destructive/90 text-destructive-foreground"],
        ["selección de menú", "bg-accent text-accent-foreground"],
        ["navegación activa", "bg-primary/10 text-primary"],
        ["error", "bg-background text-destructive"],
        ["entrada y placeholder", "bg-surface text-muted-foreground"],
        ["estado leído", "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"],
        ["estado leyendo", "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200"],
        ["estado por leer", "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200"],
        ["estado sin empezar", "bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200"],
      ]
      for (const [name, classes] of samples) {
        const probe = document.createElement("span")
        probe.className = classes
        probe.textContent = "Texto de muestra"
        container.append(probe)
        const style = getComputedStyle(probe)
        const background = composite(color(style.backgroundColor), base)
        const foreground = composite(color(style.color), background)
        measurements.push({ name, foreground, background, ratio: contrast(foreground, background), minimum: 4.5 })
        probe.remove()
      }
      const tokens = getComputedStyle(document.documentElement)
      for (const backgroundToken of ["--background", "--card", "--surface", "--input"]) {
        const background = color(tokens.getPropertyValue(backgroundToken))
        for (const foregroundToken of ["--ring", "--control-border"]) {
          const foreground = color(tokens.getPropertyValue(foregroundToken))
          measurements.push({ name: `${foregroundToken} / ${backgroundToken}`, foreground, background, ratio: contrast(foreground, background), minimum: 3 })
        }
      }
      for (const slot of ["input", "select-trigger", "button"]) {
        const control = document.createElement(slot === "input" ? "input" : "button")
        control.dataset.slot = slot
        control.className = "border border-border bg-surface"
        container.append(control)
        const style = getComputedStyle(control)
        const background = composite(color(style.backgroundColor), base)
        const foreground = composite(color(style.borderColor), background)
        measurements.push({ name: `borde computado ${slot}`, foreground, background, ratio: contrast(foreground, background), minimum: 3 })
        control.remove()
      }
      container.remove()
      return measurements
    })
    results.push({ theme, measurements: rows })
    expect(rows.filter(({ ratio, minimum }) => ratio < minimum).map(({ name, ratio, minimum }) => ({ name, ratio, minimum }))).toEqual([])
  }
  const out = path.resolve("docs/validacion/2026-10-24/O11/exp-03")
  mkdirSync(out, { recursive: true })
  writeFileSync(path.join(out, `${info.project.name}-contraste.json`), `${JSON.stringify(results, null, 2)}\n`)
})
