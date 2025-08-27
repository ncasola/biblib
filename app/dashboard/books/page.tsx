import { SortOrder } from "mongoose";

import ListBooks from "@/app/components/books/view/ListBooks";
import ButtonLink from "@/app/components/layout/ButtonLink";
import HeaderWithBg from "@/app/components/layout/HeaderWithBg";
import Heading from "@/app/components/layout/Heading";
import { connectToDb } from "@/app/config/connectToDb";
import { PersonalBook, Shelf } from "@/app/models";
import type { IPersonalBook } from "@/app/models/PersonalBook.model";
import type { IShelf } from "@/app/models/Shelf.model";
import { extractCover } from "@/app/utils/extractCover";
import { auth } from "@/auth";

export default async function Page({
    searchParams,
}: {
    searchParams: Promise<{
        page: string;
        pageSize: string;
        sort: string;
        direction: string;
        search: string;
        shelf: string;
    }>;
}) {
    const params = await searchParams;
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
        sort: { column: string; direction: string },
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
            .sort([[sort.column, sort.direction as SortOrder]])
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
    const page = parseInt(params.page) || 1;
    const pageSize = parseInt(params.pageSize) || 4;
    const sort = {
        column: params.sort || "title",
        direction: params.direction || "asc",
    };
    const search = params.search || "";
    const shelf = params.shelf || "";
    const session = await auth();
    const user = session?.user;
    const email = user?.email as string;
    const { dataBooks: books, totalData } = await fetchBooks(
        page,
        pageSize,
        sort,
        email as string,
        search,
        shelf,
    );
    const { dataShelves: shelves } = await fetchShelves(email as string);
    return (
        <div className="flex flex-col gap-4">
            <HeaderWithBg>
                <Heading title="Books" subtitle="List" />
                <ButtonLink
                    title="Add a new book"
                    href="/dashboard/books/add"
                />
            </HeaderWithBg>
            <ListBooks
                books={books}
                shelves={shelves}
                columns={["Title", "Publish date", "Image", "Shelf"]}
                totalData={totalData}
            />
        </div>
    );
}
