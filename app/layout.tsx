import "./globals.css";

import type { Metadata } from "next";
import { getServerSession } from "next-auth/next";

import { authOptions } from "@/app/api/auth/[...nextauth]/route";

import LayoutGeneral from "./components/LayoutGeneral";

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
    if (session) {
        return <LayoutGeneral session={session}>{children}</LayoutGeneral>;
    }
}
