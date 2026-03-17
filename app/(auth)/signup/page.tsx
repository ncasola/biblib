"use client"

import Link from "next/link"
import Image from "next/image"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Chrome } from "lucide-react"

export default function SignUpPage() {
  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-gradient-to-br from-vintage-olive/10 via-background to-vintage-yellow/10">
      <Card className="w-full max-w-md p-8 bg-card/80 backdrop-blur-xl border-2 border-border/50 shadow-2xl rounded-2xl">
        <div className="flex flex-col items-center mb-8">
          <Image
            src="/logo.png"
            alt="BibLib Logo"
            width={80}
            height={80}
            className="mb-4 rounded-full border-2 border-border/60 bg-card/90 p-1"
          />
          <h1 className="text-3xl font-bold heading-vintage text-center">Registro con Google</h1>
          <p className="text-muted-foreground text-center mt-2">BibLib usa Google OAuth para crear sesión</p>
        </div>

        <div className="space-y-5">
          <Button asChild className="w-full bg-vintage-olive hover:bg-vintage-olive/90 text-white rounded-xl py-6 text-lg font-semibold">
            <Link href="/login">
              <Chrome className="mr-2 h-5 w-5" />
              Ir a iniciar sesión con Google
            </Link>
          </Button>
        </div>

        <div className="mt-6 text-center">
          <p className="text-muted-foreground">
            ¿Ya tienes cuenta?{" "}
            <Link href="/login" className="text-vintage-red font-semibold hover:underline">
              Entrar
            </Link>
          </p>
        </div>
      </Card>
    </div>
  )
}
