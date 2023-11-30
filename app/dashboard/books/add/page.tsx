import AddBookForm from "@/app/components/books/add/AddBookForm";
import ButtonLink from "@/app/components/layout/ButtonLink";
import HeaderWithBg from "@/app/components/layout/HeaderWithBg";
import Heading from "@/app/components/layout/Heading";

export default async function Page() {
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
