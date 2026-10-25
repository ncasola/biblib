"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { CAMERA_MANUAL_HINT, cameraFailure, detectedIsbn, IsbnCameraSession, type IsbnDetectorConstructor } from "@/lib/isbn-camera"

/** Detección local sobre el vídeo: no almacena fotogramas ni transmite imágenes. */
export function IsbnScanner({ onDetected, disabled = false }: { onDetected: (value: string) => void; disabled?: boolean }) {
  const video = useRef<HTMLVideoElement>(null)
  const session = useRef(new IsbnCameraSession())
  const sequence = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const deadline = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [active, setActive] = useState(false)
  const [message, setMessage] = useState("")
  const [code, setCode] = useState("")
  const [needsDocument, setNeedsDocument] = useState(false)
  const confirm = useRef<HTMLButtonElement>(null)
  const startButton = useRef<HTMLButtonElement>(null)

  const release = useCallback(() => {
    sequence.current++
    clearTimeout(timer.current)
    clearTimeout(deadline.current)
    session.current.stop()
  }, [])

  useEffect(() => {
    const hide = () => {
      if (document.visibilityState === "hidden") {
        release(); setActive(false); setMessage(`Cámara detenida. ${CAMERA_MANUAL_HINT}`)
      }
    }
    document.addEventListener("visibilitychange", hide)
    return () => {
      document.removeEventListener("visibilitychange", hide)
      release()
    }
  }, [release])

  const stop = () => {
    release(); setActive(false); setMessage(`Cámara detenida. ${CAMERA_MANUAL_HINT}`)
    startButton.current?.focus()
  }

  const start = async () => {
    if (active || disabled || !video.current) return
    // Una navegación de App Router conserva el documento y su política de la ruta anterior.
    // Abrir un documento nuevo recibe la excepción /books/add sin perder el borrador de esta pestaña.
    const policies = document as Document & {
      permissionsPolicy?: { allowsFeature: (feature: string) => boolean }
      featurePolicy?: { allowsFeature: (feature: string) => boolean }
    }
    const policy = policies.permissionsPolicy ?? policies.featurePolicy
    const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined
    const cameFromAnotherDocument = navigation && new URL(navigation.name).pathname !== "/books/add"
    if ((policy && !policy.allowsFeature("camera")) || cameFromAnotherDocument) {
      setNeedsDocument(true)
      setMessage(`Esta página mantiene la restricción de cámara de la pantalla anterior. Abre el alta en otra pestaña para usarla. ${CAMERA_MANUAL_HINT}`)
      return
    }
    release()
    const request = sequence.current
    setActive(true); setCode(""); setMessage("Preparando cámara. Puedes detenerla en cualquier momento.")
    deadline.current = setTimeout(() => {
      if (sequence.current !== request) return
      stop(); setMessage(`Se ha agotado el tiempo de captura. ${CAMERA_MANUAL_HINT}`)
    }, 30_000)
    try {
      const detector = await session.current.start({
        secure: window.isSecureContext,
        detector: (window as Window & { BarcodeDetector?: IsbnDetectorConstructor }).BarcodeDetector,
        getUserMedia: navigator.mediaDevices?.getUserMedia.bind(navigator.mediaDevices),
      }, video.current)
      if (!detector || sequence.current !== request) return
      setMessage("Apunta al código de barras del libro.")
      const scan = async () => {
        if (sequence.current !== request || !video.current) return
        try {
          if (video.current.readyState >= 2) {
            const values = await detector.detect(video.current)
            if (sequence.current !== request) return
            const isbn = detectedIsbn(values)
            if (isbn) {
              release(); setActive(false); setCode(isbn); setMessage("Comprueba el código antes de usarlo. No confirma por sí solo tu edición.")
              return
            }
            if (values.length) setMessage("El código leído no es un ISBN válido. Prueba de nuevo o escríbelo manualmente.")
          }
          timer.current = setTimeout(() => void scan(), 350)
        } catch (error) {
          if (sequence.current !== request) return
          release(); setActive(false); setMessage(cameraFailure(error))
        }
      }
      void scan()
    } catch (error) {
      if (sequence.current !== request) return
      release(); setActive(false); setMessage(cameraFailure(error))
    }
  }

  useEffect(() => { if (code) confirm.current?.focus() }, [code])

  return <section aria-label="Captura ISBN por cámara" className="space-y-3 rounded-xl border border-border p-4">
    <p className="text-sm text-muted-foreground">La cámara es opcional. Las imágenes se procesan en tu dispositivo y no se guardan ni se envían. {CAMERA_MANUAL_HINT}</p>
    <video ref={video} hidden={!active} muted playsInline aria-label="Vista de la cámara para leer el ISBN" className="w-full rounded-lg" />
    <div className="flex flex-wrap gap-3">
      <Button ref={startButton} type="button" variant="outline" disabled={active || disabled} onClick={() => void start()}>Escanear ISBN con cámara</Button>
      {active && <Button type="button" variant="outline" onClick={stop}>Detener cámara</Button>}
    </div>
    <p role="status" className="text-sm">{message}</p>
    {needsDocument && <a href="/books/add" target="_blank" rel="noopener noreferrer" className="inline-block text-sm text-primary underline underline-offset-4">Abrir alta con cámara en otra pestaña</a>}
    {code && <div className="space-y-2"><p>ISBN detectado: <span className="font-mono">{code}</span></p><Button ref={confirm} type="button" disabled={disabled} onClick={() => { onDetected(code); setCode(""); setMessage("ISBN confirmado. Pulsa Buscar libro para consultar el catálogo."); startButton.current?.focus() }}>Usar este ISBN</Button></div>}
  </section>
}
