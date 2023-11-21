"use client";

import { Pagination } from "flowbite-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import type { ShelfItem } from "@/app/types/Shelf.types";

import ListTableView from "./ListTableView";

interface ListShelvesProps {
    data: ShelfItem[];
    columns: string[];
    totalData: number;
}

export default function ListShelves(props: ListShelvesProps) {
    const router = useRouter();
    const searchParams = useSearchParams();
    const { data: rows, columns, totalData } = props;
    const [currentPage, setCurrentPage] = useState(
        Number(searchParams.get("page")) || 1,
    );
    const pageSize = Number(searchParams.get("pageSize")) || 4;
    const totalPages = Math.ceil(totalData / pageSize);
    const [query, setQuery] = useState(
        `?page=${currentPage}&pageSize=${pageSize}`,
    );
    const onPageChange = (page: number) => setCurrentPage(page);

    useEffect(() => {
        const newQuery = `?page=${currentPage}&pageSize=${pageSize}`;
        if (newQuery !== query) {
            router.push(`/dashboard/shelves${newQuery}`);
            setQuery(newQuery);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentPage]);
    return (
        <>
            {totalPages > 1 && (
                <Pagination
                    currentPage={currentPage}
                    totalPages={totalPages}
                    onPageChange={onPageChange}
                    showIcons={true}
                    className="bg-white dark:bg-gray-800 p-2 rounded-md shadow-md max-w-max"
                />
            )}
            <ListTableView data={rows} columns={columns} />
        </>
    );
}
