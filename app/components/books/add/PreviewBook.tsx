"use client";

import { Spinner } from "flowbite-react";
import { useEffect, useState } from "react";

import { getBookByISBN } from "@/app/actions";
import TableDetails from "@/app/components/TableDetails";
import type { Isbn } from "@/app/schemas/Isbn.schema";

type Props = {
    isbn: string;
};

export default function PreviewBook(props: Props) {
    const { isbn } = props;
    const [prvBook, setPrvBook] = useState({} as Isbn);
    const [notFound, setNotFound] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    useEffect(() => {
        const fetchBook = async (isbn: string) => {
            const newBook = await getBookByISBN(isbn);
            if (newBook instanceof Object && "error" in newBook) {
                setIsLoading(false);
                setNotFound(true);
            } else {
                setIsLoading(false);
                setNotFound(false);
                setPrvBook(newBook);
            }
        };
        if (isbn) {
            setIsLoading(true);
            fetchBook(isbn);
        }
    }, [isbn]);

    return (
        <div className="flex justify-center items-center border-dashed border-2 border-sky-500 rounded-lg h-full">
            {isLoading && (
                <div className="text-center">
                    <Spinner aria-label="Center-aligned spinner example" />
                </div>
            )}
            {notFound && (
                <>
                    <span className="text-center font-bold text-xl">
                        Book not found, please try again
                    </span>
                </>
            )}
            {prvBook && <TableDetails data={prvBook} />}
        </div>
    );
}
