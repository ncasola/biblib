import ButtonLink from "@/app/components/layout/ButtonLink";
import HeaderWithBg from "@/app/components/layout/HeaderWithBg";
import Heading from "@/app/components/layout/Heading";
import ListShelves from "@/app/components/shelves/view/ListShelves";
import { connectToDb } from "@/app/config/connectToDb";
import { PersonalBook, Shelf } from "@/app/models";
import type { IShelf } from "@/app/models/Shelf.model";
import { ShelfItem } from "@/app/types/Shelf.types";
import { auth } from "@/auth";

export default async function Page({
    searchParams,
}: {
    searchParams: Promise<{ page: string; pageSize: string }>;
}) {
    const params = await searchParams;
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
    const page = parseInt(params.page) || 1;
    const pageSize = parseInt(params.pageSize) || 4;
    const session = await auth();
    const user = session?.user;
    const email = user?.email as string;
    const { data: shelves, totalData } = await fetchShelves(
        page,
        pageSize,
        email,
    );
    return (
        <div className="flex flex-col gap-4">
            <HeaderWithBg>
                <Heading title="Shelfs" subtitle="List" />
                <ButtonLink
                    title="Add a new Shelf"
                    href="/dashboard/shelves/add"
                />
            </HeaderWithBg>
            <ListShelves
                data={shelves}
                columns={["Title", "Number of Books"]}
                totalData={totalData}
            />
        </div>
    );
}
