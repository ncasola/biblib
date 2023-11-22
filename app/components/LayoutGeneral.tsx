"use client";

import { Session } from "next-auth";
import { SessionProvider } from "next-auth/react";

import { Menu } from "@/app/components/Menu";

type Props = {
    children: React.ReactNode;
    session: Session;
};

const LayoutGeneral = ({ children, session }: Props) => {
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
};

export default LayoutGeneral;
