"use client";

import Image from "next/image";

import { NoData } from "@/app/components/NoData";
import type { BookItem } from "@/app/types/Book.types";

type Props = {
    data: BookItem[];
};

const ListShelfView = (props: Props) => {
    const { data: books } = props;
    return (
        <div className="flex flex-col gap-4">
            {books.length === 0 ? (
                <NoData
                    title="There is no books yet"
                    subtitle="You can add a new book to your collection"
                    href="/dashboard/books/add"
                    linkTitle="Add a book"
                />
            ) : (
                <main className="shelf">
                    {books.map((book) => (
                        <div className="book-container" key={book.id}>
                            <div className="book">
                                <Image
                                    src={book.image}
                                    alt={book.title}
                                    width={200}
                                    height={300}
                                />
                            </div>
                        </div>
                    ))}
                </main>
            )}
        </div>
    );
};

export default ListShelfView;
