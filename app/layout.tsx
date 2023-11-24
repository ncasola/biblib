import "./globals.css";

import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";

import { Menu } from "@/app/components/Menu";

export const metadata: Metadata = {
    title: "BibLib",
    description: "Biblioteca de libros",
};

export default async function RootLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return (
        <ClerkProvider>
            <html lang="es">
                <body className="dot-tile">
                    <Menu />
                    <hr className="border-gray-400 dark:border-gray-700" />
                    <main className="flex justify-center items-center mt-4">
                        <div className="w-11/12 md:w-9/12 md:h-5/6">
                            {children}
                        </div>
                    </main>
                </body>
            </html>
        </ClerkProvider>
    );
}
