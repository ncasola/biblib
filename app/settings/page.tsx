"use client"

import type React from "react"

import { Header } from "@/components/header"
import { Button } from "@/components/ui/button"
import { useState, useEffect } from "react"
import { getLibraryDataAction, importLibraryDataAction } from "@/app/actions/library"
import type { LibraryData } from "@/lib/types"
import { Download, Upload, ArrowLeft, AlertCircle, CheckCircle } from "lucide-react"
import Link from "next/link"

export default function SettingsPage() {
  const [data, setData] = useState<LibraryData | null>(null)
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null)

  useEffect(() => {
    const initData = async () => {
      try {
        const loaded = await getLibraryDataAction()
        setData(loaded)
      } catch (error) {
        console.error("Error loading settings data:", error)
      }
    }
    void initData()
  }, [])

  const handleExport = () => {
    if (!data) return

    const jsonString = JSON.stringify(data, null, 2)
    const blob = new Blob([jsonString], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = `biblib-backup-${new Date().toISOString().split("T")[0]}.json`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)

    setMessage({ type: "success", text: "Datos de biblioteca exportados correctamente." })
    setTimeout(() => setMessage(null), 3000)
  }

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = async (event) => {
      try {
        const importedData = JSON.parse(event.target?.result as string) as LibraryData

        // Validate data structure
        if (!importedData.books || !Array.isArray(importedData.books)) {
          throw new Error("Formato de datos inválido: falta el arreglo de libros")
        }
        if (!importedData.shelves || !Array.isArray(importedData.shelves)) {
          throw new Error("Formato de datos inválido: falta el arreglo de estanterías")
        }

        await importLibraryDataAction(importedData)
        const refreshedData = await getLibraryDataAction()
        setData(refreshedData)

        setMessage({
          type: "success",
          text: `Se importaron ${importedData.books.length} libros y ${importedData.shelves.length} estanterías correctamente.`,
        })
        setTimeout(() => setMessage(null), 5000)
      } catch (error) {
        setMessage({
          type: "error",
          text: error instanceof Error ? error.message : "No se pudieron importar los datos. Revisa el formato del archivo.",
        })
        setTimeout(() => setMessage(null), 5000)
      }
    }

    reader.readAsText(file)
    e.target.value = ""
  }

  return (
    <div className="min-h-screen bg-background">
      <Header />

      <main className="max-w-4xl mx-auto px-4 py-12">
        <div className="mb-8">
          <Link href="/">
            <Button
              variant="ghost"
              className="mb-4 bg-transparent border-2 border-border text-foreground px-6 py-3 rounded-xl font-semibold hover:bg-muted transition-all"
            >
              <ArrowLeft className="w-4 h-4 mr-2" />
              Volver al inicio
            </Button>
          </Link>
          <h1 className="text-4xl md:text-5xl font-bold heading-vintage mb-2">Ajustes</h1>
          <p className="text-lg text-muted-foreground">Gestiona los datos de tu biblioteca</p>
        </div>

        {message && (
          <div
            className={`mb-6 p-4 rounded-xl border-2 flex items-start gap-3 ${
              message.type === "success"
                ? "bg-vintage-yellow/10 border-vintage-yellow/30"
                : "bg-vintage-red/10 border-vintage-red/30"
            }`}
          >
            {message.type === "success" ? (
              <CheckCircle className="w-5 h-5 text-vintage-yellow shrink-0 mt-0.5" />
            ) : (
              <AlertCircle className="w-5 h-5 text-vintage-red shrink-0 mt-0.5" />
            )}
            <p className={`font-medium ${message.type === "success" ? "text-vintage-yellow" : "text-vintage-red"}`}>
              {message.text}
            </p>
          </div>
        )}

        <div className="space-y-6">
          {/* Export Section */}
          <div className="rounded-2xl border border-border bg-card backdrop-blur-md p-8 shadow-xl">
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 rounded-full bg-vintage-yellow/20 flex items-center justify-center shrink-0">
                <Download className="w-6 h-6 text-vintage-yellow" />
              </div>
              <div className="flex-1">
                <h2 className="text-2xl font-bold text-foreground mb-2">Exportar datos de la biblioteca</h2>
                <p className="text-muted-foreground mb-4">
                  Descarga tu biblioteca completa como archivo JSON. Incluye libros, estanterías y progreso de lectura.
                </p>
                {data && (
                  <p className="text-sm text-foreground-light mb-4">
                    Biblioteca actual: {data.books.length} libros en {data.shelves.length} estanterías
                  </p>
                )}
                <Button
                  onClick={handleExport}
                  disabled={!data}
                  className="bg-vintage-yellow text-foreground px-6 py-3 rounded-xl font-semibold hover:scale-105 transition-all shadow-lg shadow-vintage-yellow/30"
                >
                  <Download className="w-4 h-4 mr-2" />
                  Exportar datos
                </Button>
              </div>
            </div>
          </div>

          {/* Import Section */}
          <div className="rounded-2xl border border-border bg-card backdrop-blur-md p-8 shadow-xl">
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 rounded-full bg-secondary/20 flex items-center justify-center shrink-0">
                <Upload className="w-6 h-6 text-secondary" />
              </div>
              <div className="flex-1">
                <h2 className="text-2xl font-bold text-foreground mb-2">Importar datos de biblioteca</h2>
                <p className="text-muted-foreground mb-4">
                  Sube un JSON exportado previamente para restaurar tu biblioteca. Esto reemplazará los datos actuales.
                </p>
                <div className="bg-vintage-red/10 border-2 border-vintage-red/30 rounded-xl p-4 mb-4">
                  <p className="text-sm text-vintage-red font-medium">
                    Aviso: esto sobrescribirá los datos actuales de tu biblioteca. Exporta tus datos actuales antes si
                    quieres conservarlos.
                  </p>
                </div>
                <label htmlFor="import-file">
                  <Button
                    type="button"
                    onClick={() => document.getElementById("import-file")?.click()}
                    className="bg-secondary text-secondary-foreground px-6 py-3 rounded-xl font-semibold hover:scale-105 transition-all shadow-lg shadow-secondary/30"
                  >
                    <Upload className="w-4 h-4 mr-2" />
                    Importar datos
                  </Button>
                </label>
                <input id="import-file" type="file" accept=".json" onChange={handleImport} className="hidden" />
              </div>
            </div>
          </div>

          {/* Info Section */}
          <div className="rounded-2xl border border-border/50 bg-card/80 backdrop-blur-xl p-6 shadow-lg">
            <h3 className="font-bold text-foreground mb-3">Sobre el almacenamiento de datos</h3>
            <ul className="text-sm text-muted-foreground space-y-2">
              <li>• Los datos se guardan en la base de datos y se vinculan a tu cuenta</li>
              <li>• Exporta periódicamente para crear respaldos de tu colección</li>
              <li>• Importar/exportar te permite migrar o restaurar datos</li>
              <li>• La visibilidad está protegida por usuario con Row Level Security</li>
            </ul>
          </div>
        </div>
      </main>
    </div>
  )
}
