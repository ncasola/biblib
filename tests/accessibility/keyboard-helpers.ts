import type { Locator, Page } from "@playwright/test"
import { expect } from "../e2e/lib/fixtures"

// Navega de verdad con Tab: no usa focus(), click(), fill() ni selectOption().
export async function tabTo(page: Page, target: Locator, limit = 100) {
  await expect(target).toBeVisible()
  await expect(target).toBeEnabled()
  const key = await target.evaluate((element) => {
    const active = document.activeElement
    if (active === document.body && element.closest("header")) return "Shift+Tab"
    return active && (element.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_FOLLOWING) ? "Shift+Tab" : "Tab"
  })
  const trail: string[] = []
  for (let i = 0; i < limit; i++) {
    if (await target.evaluate((element) => element === document.activeElement)) {
      expect(await target.evaluate((element) => { const style = getComputedStyle(element); return style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 2 })).toBe(true)
      const box = await target.boundingBox()
      const header = await page.locator("header").boundingBox()
      if (box && header && !await target.evaluate((element) => Boolean(element.closest("header,[role=dialog],[role=alertdialog],[role=menu],[role=listbox]")))) expect(box.y).toBeGreaterThanOrEqual(header.y + header.height - 1)
      return
    }
    if (i % 10 === 0) trail.push(await page.evaluate(() => {
      const element = document.activeElement
      return `${element?.tagName} ${element?.getAttribute("aria-label") ?? element?.textContent?.trim().slice(0, 50)} · foco de documento ${document.hasFocus()}`
    }))
    await page.keyboard.press(key)
  }
  throw new Error(`No se alcanzó con ${key}: ${target}\n${trail.join("\n")}`)
}

