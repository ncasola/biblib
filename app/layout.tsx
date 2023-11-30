import "./globals.css";

import type { Metadata } from "next";

import { Menu } from "@/app/components/layout/Menu";
import ToastItem from "@/app/components/toast/ToastItem";

import { auth } from "../auth";

export const metadata: Metadata = {
    title: "BibLib",
    description: "Biblioteca de libros",
};

export default async function RootLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    const session = await auth();
    return (
        <html lang="es">
            <body className="dot-tile">
                <Menu session={session} />
                <hr className="border-gray-400 dark:border-gray-700" />
                <main className="flex justify-center items-center mt-4">
                    <div className="w-11/12 md:w-9/12 md:h-5/6">{children}</div>
                </main>
                <footer className="flex justify-center items-center mt-4">
                    <ToastItem />
                </footer>
            </body>
        </html>
    );
}
