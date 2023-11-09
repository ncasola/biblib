"use client";

import { Pagination, ToggleSwitch } from "flowbite-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import type { BookItem } from "@/app/types/Book.types";

import ListShelfView from "./ListShelfView";
import ListTableView from "./ListTableView";
import SearchBar from "./SearchBar";

interface ListBooksProps {
    books: BookItem[];
    shelves: {
        id: string;
        title: string;
    }[];
    columns: string[];
    totalData: number;
}

export default function ListBooks(props: ListBooksProps) {
    const router = useRouter();
    const searchParams = useSearchParams();
    const { books: rows, columns, shelves, totalData } = props;
    const [tableView, setTableView] = useState(true);
    const [search, setSearch] = useState(searchParams.get("search") || "");
    const [selectShelf, setSelectShelf] = useState(
        searchParams.get("shelf") || "",
    );
    const [currentPage, setCurrentPage] = useState(
        Number(searchParams.get("page")) || 1,
    );
    const pageSize = Number(searchParams.get("pageSize")) || 4;
    const totalPages = Math.ceil(totalData / pageSize);
    const [query, setQuery] = useState(
        `?page=${currentPage}&pageSize=${pageSize}`,
    );
    const buildQuery = () => {
        const newQuery = [`?page=${currentPage}&pageSize=${pageSize}`];
        if (search) {
            newQuery.push(`&search=${search}`);
        }
        if (selectShelf) {
            newQuery.push(`&shelf=${selectShelf}`);
        }
        return newQuery.join("");
    };
    const onPageChange = (page: number) => setCurrentPage(page);

    useEffect(() => {
        const newQuery = buildQuery();
        if (newQuery !== query) {
            router.push(`/dashboard/books${newQuery}`);
            setQuery(newQuery);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentPage, search, selectShelf]);
    return (
        <>
            <div className="flex justify-end items-center gap-4">
                <ToggleSwitch
                    checked={tableView}
                    label="Change view"
                    onChange={setTableView}
                />
                <SearchBar
                    shelves={shelves}
                    setSelectShelf={setSelectShelf}
                    setSearch={setSearch}
                />
            </div>
            {tableView ? (
                <ListTableView data={rows} columns={columns} />
            ) : (
                <ListShelfView data={rows} />
            )}
            {totalPages > 1 && (
                <>
                    <Pagination
                        currentPage={currentPage}
                        totalPages={totalPages}
                        onPageChange={onPageChange}
                        showIcons={true}
                    />
                </>
            )}
        </>
    );
}
