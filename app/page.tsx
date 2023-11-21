/* eslint-disable simple-import-sort/imports */
import ButtonLink from "@/app/components/ButtonLink";
import Heading from "@/app/components/Heading";
import { getServerSession } from "next-auth/next";
import { redirect } from "next/navigation";

import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import HeaderWithBg from "@/app/components/HeaderWithBg";

export default async function Home() {
    const session = await getServerSession(authOptions);
    if (session) {
        redirect("/dashboard");
    }
    return (
        <div className="flex flex-col gap-4">
            <HeaderWithBg>
                <Heading title="Login" subtitle="in BibLib" />
                <ButtonLink title="Access" href="/login" />
            </HeaderWithBg>
        </div>
    );
}
