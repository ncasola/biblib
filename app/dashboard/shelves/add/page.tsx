import { currentUser } from "@clerk/nextjs";

import ButtonLink from "@/app/components/ButtonLink";
import HeaderWithBg from "@/app/components/HeaderWithBg";
import Heading from "@/app/components/Heading";
import AddShelfForm from "@/app/components/shelves/add/AddShelfForm";

export default async function Page() {
    const user = await currentUser();
    const email = user?.emailAddresses[0].emailAddress as string;
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
                <AddShelfForm />
            </div>
        </>
    );
}
