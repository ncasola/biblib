"use client";

import { Button, Select, TextInput } from "flowbite-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { HiRefresh, HiSearch } from "react-icons/hi";
import { useDebounce } from "use-debounce";

type Props = {
    shelves: {
        id: string;
        title: string;
    }[];
    setSelectShelf: (shelf: string) => void;
    setSearch: (search: string) => void;
    setSort: (sort: { column: string; direction: string }) => void;
};

const SearchBar = (props: Props) => {
    const { setSearch, setSelectShelf, setSort } = props;
    const searchParams = useSearchParams();
    const [column, setColumn] = useState(searchParams.get("column") || "");
    const [direction, setDirection] = useState(
        searchParams.get("direction") || "",
    );
    const [actualSearch, setActualSearch] = useState(
        searchParams.get("search") || "",
    );
    const actualShelf = searchParams.get("shelf") || "";
    const [debouncedSearch] = useDebounce(actualSearch, 1000);
    useEffect(() => {
        setSearch(debouncedSearch);
    }, [debouncedSearch, setSearch]);
    useEffect(() => {
        if (column && direction) {
            setSort({ column, direction });
        }
    }, [column, direction, setSort]);
    return (
        <>
            <TextInput
                id="search"
                placeholder="Search"
                value={actualSearch}
                onChange={(e) => setActualSearch(e.target.value)}
                rightIcon={HiSearch}
                className="w-full"
            />
            <Select
                id="shelf"
                onChange={(e) => setSelectShelf(e.target.value)}
                value={actualShelf}
                className="w-full"
            >
                <option value="">All</option>
                {props.shelves.map((shelf) => (
                    <option key={shelf.id} value={shelf.id}>
                        {shelf.title}
                    </option>
                ))}
            </Select>
            <Select
                id="column"
                onChange={(e) => setColumn(e.target.value)}
                value={column}
                className="w-full"
            >
                <option value="">None</option>
                <option value="title">Title</option>
                <option value="publishDate">Publish Date</option>
            </Select>
            <Select
                id="direction"
                onChange={(e) => setDirection(e.target.value)}
                value={direction}
                className="w-full"
            >
                <option value="">None</option>
                <option value="asc">Ascending</option>
                <option value="desc">Descending</option>
            </Select>
            <Button
                className="ml-2 w-full md:w-1/2"
                onClick={() => {
                    setSearch("");
                    setSelectShelf("");
                }}
            >
                <HiRefresh className="h-5 w-5" />
            </Button>
        </>
    );
};

export default SearchBar;
