import { getServerSession } from "next-auth";

import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import ListBooks from "@/app/components/books/view/ListBooks";
import ButtonLink from "@/app/components/ButtonLink";
import Heading from "@/app/components/Heading";
import { connectToDb } from "@/app/config/connectToDb";
import { PersonalBook, Shelf } from "@/app/models";
import type { IPersonalBook } from "@/app/models/PersonalBook.model";
import type { IShelf } from "@/app/models/Shelf.model";
import { extractCover } from "@/app/utils/extractCover";

export default async function Page({
    searchParams,
}: {
    searchParams: {
        page: string;
        pageSize: string;
        search: string;
        shelf: string;
    };
}) {
    const session = await getServerSession(authOptions);
    const fetchShelves = async (email: string) => {
        "use server";
        await connectToDb();
        const dataShelves: IShelf[] = await Shelf.find({ user: email });
        const shelves = dataShelves.map((shelf) => {
            return {
                id: shelf.id,
                title: shelf.title,
            };
        });
        return {
            dataShelves: shelves,
        };
    };
    const fetchBooks = async (
        page: number,
        pageSize: number,
        email: string,
        search: string,
        shelf: string,
    ) => {
        "use server";
        await connectToDb();
        const query: Record<string, any> = {
            user: email,
        };
        if (search) {
            query.title = { $regex: search, $options: "i" };
        }
        if (shelf) {
            query.shelf = shelf;
        }
        const dataBooks: IPersonalBook[] = await PersonalBook.find(query)
            .skip((page - 1) * pageSize)
            .limit(pageSize)
            .populate(["book", "shelf"]);
        const books = dataBooks.map((book) => {
            return {
                id: book.id,
                title: book.title,
                publishDate: book.book.data.publish_date,
                image: extractCover(book.book.data.cover),
                shelf: book.shelf.title,
            };
        });
        const totalBooks = await PersonalBook.countDocuments(query);
        return {
            dataBooks: books,
            totalData: totalBooks,
        };
    };
    const page = parseInt(searchParams.page) || 1;
    const pageSize = parseInt(searchParams.pageSize) || 4;
    const search = searchParams.search || "";
    const shelf = searchParams.shelf || "";
    const email = session?.user?.email;
    const { dataBooks: books, totalData } = await fetchBooks(
        page,
        pageSize,
        email as string,
        search,
        shelf,
    );
    const { dataShelves: shelves } = await fetchShelves(email as string);
    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-row justify-start gap-4">
                <Heading title="Books" subtitle="List" />
                <ButtonLink
                    title="Add a new book"
                    href="/dashboard/books/add"
                />
            </div>
            <ListBooks
                books={books}
                shelves={shelves}
                columns={["Title", "Publish date", "Image", "Shelf"]}
                totalData={totalData}
            />
        </div>
    );
}
