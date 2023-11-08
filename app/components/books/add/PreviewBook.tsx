"use client";

import { Spinner } from "flowbite-react";
import Image from "next/image";
import { useEffect, useState } from "react";

import { getBookByISBN } from "@/app/actions";
import TableDetails from "@/app/components/TableDetails";
import type { Isbn } from "@/app/schemas/Isbn.schema";
import { usePrvBookStore } from "@/app/stores/PrvBookStore";

export default function PreviewBook() {
    const book = usePrvBookStore((state) => state.book);
    const [prvBook, setPrvBook] = useState({} as Isbn);
    const [notFound, setNotFound] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const [cover, setCover] = useState("");
    useEffect(() => {
        const fetchBook = async () => {
            if (book) {
                const newBook = await getBookByISBN(book);
                if (newBook instanceof Object && "error" in newBook) {
                    setNotFound(true);
                } else {
                    setNotFound(false);
                    setPrvBook(newBook);
                }
            }
        };
        if (book) {
            setIsLoading(true);
            fetchBook();
        }
    }, [book]);

    useEffect(() => {
        const extractCover = (cover: {
            small: string;
            medium: string;
            large: string;
        }) => {
            const keys = Object.keys(cover);
            keys.forEach((key) => {
                const url = cover[key as keyof typeof cover];
                if (url) {
                    setCover(url);
                    setIsLoading(false);
                }
            });
        };
        if (prvBook) {
            if (prvBook.cover) {
                extractCover(prvBook.cover);
            }
        }
    }, [prvBook]);

    return (
        <div className="border-dashed border-2 border-sky-500 rounded-lg p-4">
            {isLoading && (
                <div className="flex flex-wrap gap-2">
                    <div className="text-center">
                        <Spinner aria-label="Center-aligned spinner example" />
                    </div>
                </div>
            )}
            {notFound && (
                <div className="flex flex-col gap-4">
                    <h1>Not found</h1>
                </div>
            )}
            {!notFound && cover && (
                <div className="flex flex-col gap-4">
                    <Image
                        src={cover}
                        alt="Cover"
                        width={200}
                        height={300}
                        className="rounded-xl border-solid border-red-300 shadow-xl"
                    />
                    <TableDetails data={prvBook} />
                </div>
            )}
        </div>
    );
}
