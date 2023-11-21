"use client";

import { Badge } from "flowbite-react";
import Image from "next/image";
import Link from "next/link";

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
                                <Link href={`/dashboard/books/${book.id}`}>
                                    <Image
                                        src={book.image}
                                        alt={book.title}
                                        width={200}
                                        height={300}
                                    />
                                </Link>
                            </div>
                            <div className="grid grid-cols-2 p-4 gap-2 bg-gray-100 rounded-md dark:bg-gray-700">
                                <Badge color="indigo" className="max-w-max">
                                    {book.title}
                                </Badge>
                                <Badge color="indigo" className="max-w-max">
                                    {book.publishDate}
                                </Badge>
                                <Badge color="indigo" className="max-w-max">
                                    {book.shelf}
                                </Badge>
                            </div>
                        </div>
                    ))}
                </main>
            )}
        </div>
    );
};

export default ListShelfView;
