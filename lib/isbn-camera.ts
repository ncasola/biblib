import { normalizeIsbn } from "./isbn"

export interface IsbnDetector {
  detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]>
}

export interface IsbnDetectorConstructor {
  new(options: { formats: string[] }): IsbnDetector
  getSupportedFormats(): Promise<string[]>
}

export interface CameraCapability {
  secure: boolean
  detector?: IsbnDetectorConstructor
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>
}

export const CAMERA_MANUAL_HINT = "Puedes escribir el ISBN o usar Entrada manual."

/** Solo comprueba capacidad; nunca pide permiso. */
export async function isbnDetector(capability: CameraCapability): Promise<IsbnDetector> {
  if (!capability.secure || !capability.detector || !capability.getUserMedia) {
    throw new Error(`Este navegador no permite escanear ISBN. ${CAMERA_MANUAL_HINT}`)
  }
  const formats = (await capability.detector.getSupportedFormats()).filter((format) => format === "ean_13")
  if (!formats.length) throw new Error(`Este navegador no detecta códigos EAN de libros. ${CAMERA_MANUAL_HINT}`)
  return new capability.detector({ formats })
}

export function detectedIsbn(values: { rawValue: string }[]): string | null {
  for (const { rawValue } of values) {
    const isbn = normalizeIsbn(rawValue)
    if (isbn) return isbn
  }
  return null
}

export function cameraFailure(error: unknown): string {
  return error instanceof Error && ["NotAllowedError", "SecurityError"].includes(error.name)
    ? `No se ha permitido usar la cámara. ${CAMERA_MANUAL_HINT}`
    : `No se pudo iniciar o leer la cámara. ${CAMERA_MANUAL_HINT}`
}

/** Propiedad de la captura: parar invalida incluso un permiso o una detección que lleguen tarde. */
export class IsbnCameraSession {
  private generation = 0
  private stream: MediaStream | null = null
  private video: HTMLVideoElement | null = null

  stop() {
    this.generation++
    this.stream?.getTracks().forEach((track) => track.stop())
    this.stream = null
    if (this.video) this.video.srcObject = null
    this.video = null
  }

  async start(capability: CameraCapability, video: HTMLVideoElement): Promise<IsbnDetector | null> {
    this.stop()
    const generation = this.generation
    const detector = await isbnDetector(capability)
    if (generation !== this.generation) return null
    // Única llamada que solicita permiso; start solo se invoca desde el botón de la persona.
    const stream = await capability.getUserMedia!({ video: { facingMode: { ideal: "environment" } }, audio: false })
    if (generation !== this.generation) {
      stream.getTracks().forEach((track) => track.stop())
      return null
    }
    this.stream = stream
    this.video = video
    video.srcObject = stream
    await video.play()
    return generation === this.generation ? detector : null
  }
}
