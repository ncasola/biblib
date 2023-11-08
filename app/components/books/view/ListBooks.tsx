"use client";

import { Pagination, ToggleSwitch } from "flowbite-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import type { BookItem } from "@/app/types/Book.types";

import ListShelfView from "./ListShelfView";
import ListTableView from "./ListTableView";

interface ListBooksProps {
    data: BookItem[];
    columns: string[];
    totalData: number;
}

export default function ListBooks(props: ListBooksProps) {
    const router = useRouter();
    const searchParams = useSearchParams();
    const { data: rows, columns, totalData } = props;
    const [tableView, setTableView] = useState(true);
    const [currentPage, setCurrentPage] = useState(
        Number(searchParams.get("page")) || 1,
    );
    const pageSize = Number(searchParams.get("pageSize")) || 5;
    const totalPages = Math.ceil(totalData / pageSize);
    const [query, setQuery] = useState(
        `?page=${currentPage}&pageSize=${pageSize}`,
    );
    const onPageChange = (page: number) => setCurrentPage(page);

    useEffect(() => {
        const newQuery = `?page=${currentPage}&pageSize=${pageSize}`;
        if (newQuery !== query) {
            router.push(`/dashboard/books${newQuery}`);
            setQuery(newQuery);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentPage]);
    return (
        <>
            <ToggleSwitch
                checked={tableView}
                label="Change view"
                onChange={setTableView}
            />
            <Pagination
                currentPage={currentPage}
                totalPages={totalPages}
                onPageChange={onPageChange}
                showIcons={true}
            />
            {tableView ? (
                <ListTableView data={rows} columns={columns} />
            ) : (
                <ListShelfView data={rows} />
            )}
        </>
    );
}
