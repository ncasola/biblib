import { getServerSession } from "next-auth";

import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import ButtonLink from "@/app/components/ButtonLink";
import Heading from "@/app/components/Heading";
import AddShelfForm from "@/app/components/shelves/add/AddShelfForm";

export default async function Page() {
    const session = await getServerSession(authOptions);
    const email = session?.user?.email;
    return (
        <>
            <div className="flex flex-row justify-start gap-4">
                <Heading title="Add" subtitle="Book" />
                <ButtonLink
                    title="Return to Shelves"
                    href="/dashboard/shelves"
                />
            </div>
            <div className="add-book">
                <div className="form-add-book">
                    <AddShelfForm user={email as string} />
                </div>
            </div>
        </>
    );
}
