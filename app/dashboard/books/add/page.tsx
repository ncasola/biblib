import { getServerSession } from "next-auth";

import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import AddBookForm from "@/app/components/books/add/AddBookForm";
import ButtonLink from "@/app/components/ButtonLink";
import HeaderWithBg from "@/app/components/HeaderWithBg";
import Heading from "@/app/components/Heading";

export default async function Page() {
    const session = await getServerSession(authOptions);
    const email = session?.user?.email;

    return (
        <>
            <HeaderWithBg>
                <Heading title="Add" subtitle="Book" />
                <ButtonLink title="Return to books" href="/dashboard/books" />
            </HeaderWithBg>
            <div className="flex flex-col gap-4 mt-4">
                <AddBookForm />
            </div>
        </>
    );
}
