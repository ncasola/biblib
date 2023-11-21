/* eslint-disable simple-import-sort/imports */
import { getServerSession } from "next-auth/next";
import { getProviders } from "next-auth/react";
import { redirect } from "next/navigation";

import { authOptions } from "@/app/api/auth/[...nextauth]/route";

import LoginForm from "../components/auth/LoginForm";

export default async function LoginPage() {
    const session = await getServerSession(authOptions);
    if (session) {
        redirect("/dashboard");
    }
    const providers = await getProviders();
    return (
        <div>
            {providers?.github && <LoginForm provider={providers.github} />}
        </div>
    );
}
