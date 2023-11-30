"use client";

import { useWindowSize } from "@uidotdev/usehooks";
import { Pagination, ToggleSwitch } from "flowbite-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import type { BookItem } from "@/app/types/Book.types";

import ListResponsiveView from "./ListResponsiveView";
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
    const { width } = useWindowSize();
    const searchParams = useSearchParams();
    const { books: rows, columns, shelves, totalData } = props;
    const [tableView, setTableView] = useState(true);
    const [responsiveView, setResponsiveView] = useState(false);
    const [search, setSearch] = useState(searchParams.get("search") || "");
    const [sort, setSort] = useState({
        column: searchParams.get("sort") || "title",
        direction: searchParams.get("direction") || "asc",
    });
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
        if (sort.column && sort.direction) {
            newQuery.push(`&sort=${sort.column}&direction=${sort.direction}`);
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
    }, [currentPage, search, selectShelf, sort]);
    useEffect(() => {
        if (width && width < 768) {
            setResponsiveView(true);
        } else {
            setResponsiveView(false);
        }
    }, [width]);
    return (
        <>
            <div className="grid grid-rows-1 place-items-center gap-4 md:grid-flow-col md:gap-4 rounded-lg shadow-md dark:bg-gray-800 bg-gray-100 p-4">
                <ToggleSwitch
                    checked={tableView}
                    label="Change view"
                    onChange={setTableView}
                />
                <SearchBar
                    shelves={shelves}
                    setSelectShelf={setSelectShelf}
                    setSearch={setSearch}
                    setSort={setSort}
                />
            </div>
            {tableView && !responsiveView && (
                <ListTableView data={rows} columns={columns} sort={sort} />
            )}
            {!tableView && !responsiveView && <ListShelfView data={rows} />}
            {responsiveView && <ListResponsiveView data={rows} />}
            {totalPages > 1 && (
                <>
                    <Pagination
                        currentPage={currentPage}
                        totalPages={totalPages}
                        onPageChange={onPageChange}
                        showIcons={true}
                        className="bg-white dark:bg-gray-800 p-2 rounded-md shadow-md max-w-max"
                    />
                </>
            )}
        </>
    );
}
