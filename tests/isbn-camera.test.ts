import assert from "node:assert/strict"
import { test } from "node:test"
import { cameraFailure, detectedIsbn, isbnDetector, IsbnCameraSession, type CameraCapability } from "../lib/isbn-camera"
import { entrySearchDeadline, SubmissionGate } from "../lib/book-entry"

class CompatibleDetector {
  static async getSupportedFormats() { return ["ean_13", "qr_code"] }
  constructor(readonly options: { formats: string[] }) {}
  async detect() { return [{ rawValue: "978-0-7475-3269-9" }] }
}

function capture() {
  let requests = 0, stops = 0
  const constraints: MediaStreamConstraints[] = []
  const stream = { getTracks: () => [{ stop: () => { stops++ } }] } as unknown as MediaStream
  const capability: CameraCapability = {
    secure: true, detector: CompatibleDetector,
    getUserMedia: async (value) => { requests++; constraints.push(value); return stream },
  }
  const video = { srcObject: null, play: async () => {} } as unknown as HTMLVideoElement
  return { capability, video, stream, constraints, requests: () => requests, stops: () => stops }
}

test("detector compatible: comprobar capacidad no solicita permiso y solo se pide vídeo al iniciar", async () => {
  const fixture = capture()
  const detector = await isbnDetector(fixture.capability)
  assert.ok(detector instanceof CompatibleDetector)
  assert.deepEqual(detector.options.formats, ["ean_13"])
  assert.equal(fixture.requests(), 0)
  const session = new IsbnCameraSession()
  assert.ok(await session.start(fixture.capability, fixture.video))
  assert.equal(fixture.requests(), 1)
  assert.deepEqual(fixture.constraints, [{ video: { facingMode: { ideal: "environment" } }, audio: false }])
  assert.equal(fixture.video.srcObject, fixture.stream)
  session.stop()
  assert.equal(fixture.stops(), 1)
  assert.equal(fixture.video.srcObject, null)
})

test("sin HTTPS, detector o EAN compatible: no pide cámara y explica la alternativa manual", async () => {
  for (const override of [
    { secure: false }, { detector: undefined }, { getUserMedia: undefined },
    { detector: class extends CompatibleDetector { static async getSupportedFormats() { return ["qr_code"] } } },
  ]) {
    const fixture = capture()
    await assert.rejects(isbnDetector({ ...fixture.capability, ...override }), /Entrada manual/)
    assert.equal(fixture.requests(), 0)
  }
})

test("permiso denegado conserva una salida manual completa, sin reintento automático", async () => {
  const fixture = capture()
  let requests = 0
  const error = new DOMException("denegado", "NotAllowedError")
  const session = new IsbnCameraSession()
  await assert.rejects(session.start({ ...fixture.capability, getUserMedia: async () => { requests++; throw error } }, fixture.video))
  assert.equal(requests, 1)
  assert.equal(fixture.video.srcObject, null)
  assert.match(cameraFailure(error), /No se ha permitido.*ISBN.*Entrada manual/)
})

test("lectura inválida, longitud, checksum y EAN comercial no producen ISBN; guiones e ISBN-10 se normalizan", () => {
  for (const value of ["", "978074753269", "9780747532698", "1234567890128", "97807475326999", "https://externo.invalid/"]) {
    assert.equal(detectedIsbn([{ rawValue: value }]), null, value)
  }
  assert.equal(detectedIsbn([{ rawValue: "inválido" }, { rawValue: "978-0-7475-3269-9" }]), "9780747532699")
  assert.equal(detectedIsbn([{ rawValue: "0-7475-3269-9" }]), "9780747532699")
})

test("parar durante el permiso detiene todas las pistas que lleguen tarde sin adjuntar vídeo", async () => {
  const fixture = capture()
  let resolve: (stream: MediaStream) => void = () => {}
  const pending = new Promise<MediaStream>((done) => { resolve = done })
  let requested: () => void = () => {}
  const started = new Promise<void>((done) => { requested = done })
  const session = new IsbnCameraSession()
  const start = session.start({ ...fixture.capability, getUserMedia: () => { requested(); return pending } }, fixture.video)
  await started
  session.stop()
  resolve(fixture.stream)
  assert.equal(await start, null)
  assert.equal(fixture.stops(), 1)
  assert.equal(fixture.video.srcObject, null)
})

test("doble toque síncrono en guardar solo entra una vez; un error permite reintentar", async () => {
  const gate = new SubmissionGate()
  let requests = 0
  let complete: () => void = () => {}
  const pending = new Promise<void>((resolve) => { complete = resolve })
  const save = async () => {
    if (!gate.enter()) return
    try { requests++; await pending; throw new Error("red interrumpida") }
    catch { /* El formulario conserva los campos, solo libera el cierre. */ }
    finally { gate.leave() }
  }
  const first = save(), second = save()
  assert.equal(requests, 1)
  complete()
  await Promise.all([first, second])
  await save()
  assert.equal(requests, 2)
})

test("timeout del catálogo aborta la consulta y distingue el plazo agotado de una ausencia", async () => {
  const controller = new AbortController()
  await assert.rejects(entrySearchDeadline(() => new Promise<never>(() => {}), controller, 5), { name: "AbortError" })
  assert.equal(controller.signal.aborted, true)
  assert.equal(await entrySearchDeadline(async () => null, new AbortController(), 100), null)
})
