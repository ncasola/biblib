import { getServerSession } from "next-auth";

import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import ButtonLink from "@/app/components/ButtonLink";
import Heading from "@/app/components/Heading";
import ListShelves from "@/app/components/shelves/view/ListShelves";
import { connectToDb } from "@/app/config/connectToDb";
import { PersonalBook, Shelf } from "@/app/models";
import type { IShelf } from "@/app/models/Shelf.model";
import { ShelfItem } from "@/app/types/Shelf.types";

export default async function Page({
    searchParams,
}: {
    searchParams: { page: string; pageSize: string };
}) {
    const session = await getServerSession(authOptions);
    const fetchShelves = async (
        page: number,
        pageSize: number,
        email: string,
    ) => {
        "use server";
        await connectToDb();
        const data: IShelf[] = await Shelf.find({ user: email })
            .skip((page - 1) * pageSize)
            .limit(pageSize);
        const shelves: ShelfItem[] = [];
        for (const shelf of data) {
            const totalBooks = await PersonalBook.countDocuments({
                shelf: shelf.id,
            });
            shelves.push({
                id: shelf.id,
                title: shelf.title,
                totalBooks,
            });
        }
        const totalShelfs = await Shelf.countDocuments({ user: email });
        return {
            data: shelves,
            totalData: totalShelfs,
        };
    };
    const page = parseInt(searchParams.page) || 1;
    const pageSize = parseInt(searchParams.pageSize) || 4;
    const email = session?.user?.email;
    const { data: shelves, totalData } = await fetchShelves(
        page,
        pageSize,
        email as string,
    );
    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-row justify-start gap-4">
                <Heading title="Shelfs" subtitle="List" />
                <ButtonLink
                    title="Add a new Shelf"
                    href="/dashboard/shelves/add"
                />
            </div>
            <ListShelves
                data={shelves}
                columns={["Title", "Number of Books"]}
                totalData={totalData}
            />
        </div>
    );
}
