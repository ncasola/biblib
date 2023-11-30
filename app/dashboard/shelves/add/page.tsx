import ButtonLink from "@/app/components/layout/ButtonLink";
import HeaderWithBg from "@/app/components/layout/HeaderWithBg";
import Heading from "@/app/components/layout/Heading";
import AddShelfForm from "@/app/components/shelves/add/AddShelfForm";

export default async function Page() {
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
