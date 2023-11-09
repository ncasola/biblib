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
};

const SearchBar = (props: Props) => {
    const { setSearch, setSelectShelf } = props;
    const searchParams = useSearchParams();
    const [actualSearch, setActualSearch] = useState(
        searchParams.get("search") || "",
    );
    const actualShelf = searchParams.get("shelf") || "";
    const [debouncedSearch] = useDebounce(actualSearch, 1000);
    useEffect(() => {
        setSearch(debouncedSearch);
    }, [debouncedSearch, setSearch]);
    return (
        <>
            <div className="max-w-md">
                <TextInput
                    id="search"
                    placeholder="Search"
                    value={actualSearch}
                    onChange={(e) => setActualSearch(e.target.value)}
                    rightIcon={HiSearch}
                />
            </div>
            <div className="max-w-md">
                <Select
                    id="shelf"
                    placeholder="Shelf"
                    onChange={(e) => setSelectShelf(e.target.value)}
                    value={actualShelf}
                >
                    <option value="">All</option>
                    {props.shelves.map((shelf) => (
                        <option key={shelf.id} value={shelf.id}>
                            {shelf.title}
                        </option>
                    ))}
                </Select>
            </div>
            <div className="max-w-md">
                <Button
                    className="ml-2"
                    onClick={() => {
                        setSearch("");
                        setSelectShelf("");
                    }}
                >
                    <HiRefresh className="h-5 w-5" />
                </Button>
            </div>
        </>
    );
};

export default SearchBar;
