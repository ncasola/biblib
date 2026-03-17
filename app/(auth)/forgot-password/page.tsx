"use client"

import Link from "next/link"
import Image from "next/image"
import { Card } from "@/components/ui/card"
import { ArrowLeft } from "lucide-react"

export default function ForgotPasswordPage() {
  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-gradient-to-br from-vintage-purple/10 via-background to-vintage-red/10">
      <Card className="w-full max-w-md p-8 bg-card/80 backdrop-blur-xl border-2 border-border/50 shadow-2xl rounded-2xl">
        <div className="flex flex-col items-center mb-8">
          <Image
            src="/logo.png"
            alt="BibLib Logo"
            width={80}
            height={80}
            className="mb-4 rounded-full border-2 border-border/60 bg-card/90 p-1"
          />
          <h1 className="text-3xl font-bold heading-vintage text-center">Recuperación de contraseña</h1>
          <p className="text-muted-foreground text-center mt-2">
            Este proyecto usa solo Google OAuth, por eso no hay reseteo por email.
          </p>
        </div>

        <div className="space-y-6" />

        <div className="mt-6 text-center">
          <Link href="/login" className="text-vintage-red hover:underline inline-flex items-center font-semibold">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Volver al login
          </Link>
        </div>
      </Card>
    </div>
  )
}
