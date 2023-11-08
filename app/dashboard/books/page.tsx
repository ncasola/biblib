import { getServerSession } from "next-auth";

import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import ListBooks from "@/app/components/books/view/ListBooks";
import ButtonLink from "@/app/components/ButtonLink";
import Heading from "@/app/components/Heading";
import { connectToDb } from "@/app/config/connectToDb";
import { PersonalBook } from "@/app/models";
import type { IPersonalBook } from "@/app/models/PersonalBook.model";
import { extractCover } from "@/app/utils/extractCover";

export default async function Page({
    searchParams,
}: {
    searchParams: { page: string; pageSize: string };
}) {
    const session = await getServerSession(authOptions);
    const fetchBooks = async (
        page: number,
        pageSize: number,
        email: string,
    ) => {
        "use server";
        await connectToDb();
        const data: IPersonalBook[] = await PersonalBook.find({ user: email })
            .skip((page - 1) * pageSize)
            .limit(pageSize)
            .populate("book");
        const books = data.map((book) => {
            return {
                id: book.id,
                title: book.book.data.title,
                publishDate: book.book.data.publish_date,
                image: extractCover(book.book.data.cover),
            };
        });
        const totalBooks = await PersonalBook.countDocuments({ user: email });
        return {
            data: books,
            totalData: totalBooks,
        };
    };
    const page = parseInt(searchParams.page) || 1;
    const pageSize = parseInt(searchParams.pageSize) || 5;
    const email = session?.user?.email;
    const { data: books, totalData } = await fetchBooks(
        page,
        pageSize,
        email as string,
    );
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
                data={books}
                columns={["Title", "Publish date", "Image"]}
                totalData={totalData}
            />
        </div>
    );
}
