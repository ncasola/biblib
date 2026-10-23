import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { fileHashes, verifyRelease } from "./release.mjs"

test("el release rechaza destino, huella, commit, lockfile, historial y binario distintos", () => {
  const original = { schemaVersion: 1, target: "preprod", publicFingerprint: "a", commit: "b", lockfileSha256: "c", migrations: ["d"], files: { build: "e" } }
  assert.doesNotThrow(() => verifyRelease(original, structuredClone(original)))
  for (const [key, replacement] of Object.entries({ target: "prod", publicFingerprint: "otra", commit: "otro", lockfileSha256: "otro", migrations: ["otra"], files: { build: "otro" } })) {
    assert.throws(() => verifyRelease(original, { ...original, [key]: replacement }), (error) => error.code === (["target", "publicFingerprint"].includes(key) ? 3 : 6))
  }
})

test("checksums detectan archivos modificados y añadidos; cache no se publica", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "biblib-ci-"))
  try {
    mkdirSync(path.join(root, ".next/cache"), { recursive: true })
    writeFileSync(path.join(root, ".next/main.js"), "primero")
    writeFileSync(path.join(root, ".next/cache/privado"), "no distribuir")
    const before = fileHashes(root, ".next")
    assert.deepEqual(Object.keys(before), [".next/main.js"])
    writeFileSync(path.join(root, ".next/main.js"), "segundo")
    assert.notDeepEqual(before, fileHashes(root, ".next"))
    writeFileSync(path.join(root, ".next/extra.js"), "extra")
    assert.equal(Object.keys(fileHashes(root, ".next")).length, 2)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("un enlace no puede introducir archivos externos en el artefacto", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "biblib-ci-"))
  try {
    mkdirSync(path.join(root, "build"))
    mkdirSync(path.join(root, "external"))
    symlinkSync(path.join(root, "external"), path.join(root, "build/link"), process.platform === "win32" ? "junction" : "dir")
    assert.throws(() => fileHashes(root, "build"), (error) => error.code === 3)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
