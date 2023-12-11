"use client";

import { useEffect, useState } from "react";
import { HiArrowCircleRight } from "react-icons/hi";

import type { Isbn } from "@/app/schemas/Isbn.schema";

interface Props {
    data: Isbn;
}

const TableDetails: React.FC<Props> = ({ data }) => {
    const [trimmedTitle, setTrimmedTitle] = useState("");
    const [url, setUrl] = useState("");
    useEffect(() => {
        if (data && data.title) {
            const title = data.title.slice(0, 50);
            const trimmedTitle =
                title.length < data.title.length ? `${title}...` : title;
            setTrimmedTitle(trimmedTitle);
        }
        if (data && data.url) {
            setUrl(data.url);
        }
    }, [data]);
    return (
        <span className="font-bold text-gray-700 dark:text-gray-300">
            {trimmedTitle}
            {url && (
                <>
                    |{" "}
                    <a href={url} target="_blank" rel="noreferrer">
                        <HiArrowCircleRight className="inline-block" />
                        <span className="text-blue-500">OpenLibrary Page</span>
                    </a>
                </>
            )}
        </span>
    );
};

export default TableDetails;
