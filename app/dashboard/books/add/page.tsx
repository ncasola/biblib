import { getServerSession } from "next-auth";

import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import AddBookForm from "@/app/components/books/add/AddBookForm";
import PreviewBook from "@/app/components/books/add/PreviewBook";
import ButtonLink from "@/app/components/ButtonLink";
import Heading from "@/app/components/Heading";
import { connectToDb } from "@/app/config/connectToDb";
import { Shelf } from "@/app/models";
import type { IShelf } from "@/app/models/Shelf.model";

export default async function Page() {
    const session = await getServerSession(authOptions);
    const fetchShelves = async (email: string) => {
        "use server";
        await connectToDb();
        const shelves: IShelf[] = await Shelf.find({ user: email });
        const data = shelves.map((shelf) => {
            return {
                value: shelf.id,
                label: shelf.title,
            };
        });
        return data;
    };
    const email = session?.user?.email;
    const shelves: { value: string; label: string }[] = await fetchShelves(
        email as string,
    );
    return (
        <>
            <div className="flex flex-row justify-start gap-4">
                <Heading title="Add" subtitle="Book" />
                <ButtonLink title="Return to books" href="/dashboard/books" />
            </div>
            <div className="add-book">
                <div className="form-add-book">
                    <AddBookForm shelves={shelves} user={email as string} />
                </div>
                <div className="preview-add-book">
                    <PreviewBook />
                </div>
            </div>
        </>
    );
}
