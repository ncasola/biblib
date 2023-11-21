import { getServerSession } from "next-auth";

import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import ButtonLink from "@/app/components/ButtonLink";
import HeaderWithBg from "@/app/components/HeaderWithBg";
import Heading from "@/app/components/Heading";
import AddShelfForm from "@/app/components/shelves/add/AddShelfForm";

export default async function Page() {
    const session = await getServerSession(authOptions);
    const email = session?.user?.email;
    return (
        <>
            <HeaderWithBg>
                <Heading title="Add" subtitle="Shelf" />
                <ButtonLink
                    title="Return to Shelves"
                    href="/dashboard/shelves"
                />
            </HeaderWithBg>
            <div className="flex flex-col gap-4 mt-4">
                <AddShelfForm user={email as string} />
            </div>
        </>
    );
}
