import { redirect } from "next/navigation";

import { auth } from "@/auth";

export default async function DashboardLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    const session = await auth();
    if (!session) {
        redirect("/api/auth/signin");
    } else {
        return <>{children}</>;
    }
}
