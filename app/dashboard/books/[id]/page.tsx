import BookView from "@/app/components/books/view/BookView";
import ButtonLink from "@/app/components/layout/ButtonLink";
import HeaderWithBg from "@/app/components/layout/HeaderWithBg";
import Heading from "@/app/components/layout/Heading";
import { NoData } from "@/app/components/layout/NoData";
import { connectToDb } from "@/app/config/connectToDb";
import { PersonalBook } from "@/app/models";
import type { IPersonalBook } from "@/app/models/PersonalBook.model";
import { extractCover } from "@/app/utils/extractCover";

export default async function Page({ params }: { params: { id: string } }) {
    const fetchBook = async (id: string) => {
        "use server";
        await connectToDb();
        const book: IPersonalBook | null = await PersonalBook.findById(id)
            .populate(["book", "shelf"])
            .exec();
        if (!book) {
            return null;
        }
        return {
            id: book.id,
            title: book.title,
            publishDate: book.book.data.publish_date,
            image: extractCover(book.book.data.cover),
            shelf: book.shelf.title,
            data: book.book.data,
        };
    };
    const book = await fetchBook(params.id);
    return (
        <>
            <HeaderWithBg>
                <Heading title={book?.title || "Book"} subtitle="" />
                <ButtonLink title="Return to books" href="/dashboard/books" />
            </HeaderWithBg>
            <div className="flex flex-col gap-4 mt-4">
                {book ? (
                    <BookView dataBook={book} />
                ) : (
                    <NoData
                        title="Book not found"
                        href="/dashboard/books"
                        linkTitle="Go back"
                        subtitle="The book you are looking for does not exist"
                    />
                )}
            </div>
        </>
    );
}
