"use client";
import { Badge, Select } from "flowbite-react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { changeShelf, getShelvesCurrentUser } from "@/app/actions";
import type { Isbn } from "@/app/schemas/Isbn.schema";
import { BookItem } from "@/app/types/Book.types";
import type { ShelfSelect } from "@/app/types/Shelf.types";

interface BookView extends BookItem {
    data: Isbn;
}

interface Props {
    dataBook: BookView;
}

const BookView = (props: Props) => {
    const { dataBook } = props;
    const router = useRouter();
    const [shelves, setShelves] = useState<ShelfSelect[]>([]);
    const [errorMessage, setErrorMessage] = useState("");
    const handlerChangeShelf = async (id: string, shelf: string) => {
        const result = await changeShelf(id, shelf);
        if (typeof result === "object" && "error" in result) {
            setErrorMessage(result.error);
        } else {
            router.refresh();
        }
    };
    useEffect(() => {
        const getShelves = async () => {
            const shelves = await getShelvesCurrentUser();
            setShelves(shelves);
        };
        getShelves();
    }, []);
    return (
        <div className="max-w-max mx-auto px-4 sm:px-6 bg-gray-100 dark:bg-gray-800 py-8">
            <div className="flex flex-col md:flex-row -mx-4">
                <div className="md:flex-1 px-4">
                    <div className="flex flex-col md:flex-row md:-mx-4 items-center justify-center h-64 md:h-80 overflow-hidden rounded-lg">
                        <Image
                            src={dataBook.image}
                            alt={dataBook.title}
                            width={200}
                            height={300}
                            className="rounded-lg shadow-md"
                        />
                    </div>
                </div>
                <div className="md:flex-1 px-4">
                    <h2 className="text-2xl font-bold text-gray-800 dark:text-white mb-2">
                        {dataBook.title}
                    </h2>
                    <p className="text-gray-600 dark:text-gray-300 text-sm mb-4">
                        {dataBook.data.notes || ""}
                        {dataBook.data.subtitle || ""}
                    </p>
                    <div className="flex mb-4">
                        <div className="mr-4">
                            <span className="font-bold text-gray-700 dark:text-gray-300">
                                Publish Date:
                            </span>
                            <span className="text-gray-600 dark:text-gray-300">
                                <Badge color="indigo" className="max-w-max">
                                    {dataBook.publishDate}
                                </Badge>
                            </span>
                        </div>
                    </div>
                    <div className="mb-4">
                        <span className="font-bold text-gray-700 dark:text-gray-300">
                            Shelf:
                            <Badge color="indigo" className="max-w-max mb-4">
                                {dataBook.shelf}
                            </Badge>
                        </span>
                        <Select
                            className="max-w-max"
                            placeholder="Select a shelf"
                            onChange={(e) =>
                                handlerChangeShelf(dataBook.id, e.target.value)
                            }
                        >
                            <option value="">All</option>
                            {shelves.length > 0 && (
                                <>
                                    {shelves.map((shelf) => (
                                        <option
                                            key={shelf.value}
                                            value={shelf.value}
                                        >
                                            {shelf.label}
                                        </option>
                                    ))}
                                </>
                            )}
                        </Select>
                        <span className="text-gray-600 dark:text-gray-300">
                            {errorMessage}
                        </span>
                    </div>
                    <div className="mb-4">
                        <span className="font-bold text-gray-700 dark:text-gray-300">
                            Author
                            {dataBook.data.authors.length > 1 ? "s" : ""}:{" "}
                            {dataBook.data.authors.map((author) => (
                                <span key={author.name}>{author.name}</span>
                            ))}
                        </span>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default BookView;
