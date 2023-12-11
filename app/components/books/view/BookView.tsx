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
        <div className="flex flex-col items-center bg-white border border-gray-200 rounded-lg shadow md:flex-row md:max-w-xl hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-800 dark:hover:bg-gray-700">
            <Image
                src={dataBook.image}
                alt={dataBook.title}
                className="object-cover w-full rounded-t-lg h-96 md:h-auto md:w-48 md:rounded-none md:rounded-s-lg"
                width={100}
                height={100}
                sizes="(max-width: 768px) 100vw,
                            (max-width: 1200px) 50vw,
                            33vw"
            />
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
                    <span className="font-bold text-gray-700 dark:text-gray-300">
                        Change shelf:
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
    );
};

export default BookView;
