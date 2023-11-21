import "./globals.css";

import type { Metadata } from "next";
import { getServerSession } from "next-auth/next";
import { SessionProvider } from "next-auth/react";

import { authOptions } from "@/app/api/auth/[...nextauth]/route";
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
    const session = await getServerSession(authOptions);
    return (
        <html lang="es">
            <body className="dot-tile">
                <SessionProvider session={session}>
                    <Menu />
                    <hr className="border-gray-400 dark:border-gray-700" />
                    <main className="flex justify-center items-center mt-4">
                        <div className="w-11/12 md:w-9/12 md:h-5/6">
                            {children}
                        </div>
                    </main>
                </SessionProvider>
            </body>
        </html>
    );
}
