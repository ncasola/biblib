import {
    Badge,
    Button,
    ButtonGroup,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeadCell,
    TableRow,
} from "flowbite-react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { HiArrowDown, HiArrowUp } from "react-icons/hi";

import { deleteBook } from "@/app/actions";
import { DeleteConfirm } from "@/app/components/layout/DeleteConfirm";
import { NoData } from "@/app/components/layout/NoData";
import { useToastStore } from "@/app/stores/ToastStore";
import type { BookItem } from "@/app/types/Book.types";

interface Props {
    data: BookItem[];
    sort: {
        column: string;
        direction: string;
    };
    columns: string[];
}

const ListTableView = (props: Props) => {
    const router = useRouter();
    const { setToast } = useToastStore();
    const { data: rows, columns, sort } = props;
    const [openModal, setOpenModal] = useState(false);
    const [result, setResult] = useState(false);
    const [bookToDelete, setBookToDelete] = useState<string | null>(null);
    const toCamelCase = (str: string) => {
        return str
            .replace(/(?:^\w|[A-Z]|\b\w)/g, (letter, index) => {
                return index === 0
                    ? letter.toLowerCase()
                    : letter.toUpperCase();
            })
            .replace(/\s+/g, "");
    };
    const deleteHandler = (id: string) => {
        console.log("id", id);
        setOpenModal(true);
        setBookToDelete(id);
    };
    useEffect(() => {
        const deleteBookHandler = async (bookToDelete: string) => {
            const deleted = await deleteBook(bookToDelete);
            return deleted;
        };
        if (bookToDelete && result) {
            deleteBookHandler(bookToDelete);
            setBookToDelete(null);
            setResult(false);
            setToast("Book deleted successfully", "green");
            router.refresh();
        }
    }, [result, bookToDelete, router, setToast]);
    return (
        <>
            <Table>
                <TableHead>
                    <>
                        {columns.map((column) => (
                            <TableHeadCell key={column}>
                                <span className="flex items-center">
                                    {toCamelCase(column) === sort.column && (
                                        <>
                                            {sort.direction === "asc" ? (
                                                <HiArrowUp />
                                            ) : (
                                                <HiArrowDown />
                                            )}
                                        </>
                                    )}
                                    {column}
                                </span>
                            </TableHeadCell>
                        ))}
                    </>
                    <TableHeadCell>Actions</TableHeadCell>
                </TableHead>
                <TableBody>
                    {rows &&
                        rows.map((row) => (
                            <TableRow
                                className="bg-white border-b dark:bg-gray-800 dark:border-gray-700"
                                key={row.id}
                            >
                                <TableCell>{row.title}</TableCell>
                                <TableCell>
                                    {new Date(
                                        row.publishDate,
                                    ).toLocaleDateString("en-US", {
                                        year: "numeric",
                                        month: "long",
                                        day: "numeric",
                                    })}
                                </TableCell>
                                <TableCell>
                                    <Image
                                        src={row.image}
                                        alt={row.title}
                                        width={50}
                                        height={50}
                                        className="rounded-lg shadow-md"
                                    />
                                </TableCell>
                                <TableCell>
                                    <Badge color="indigo" className="max-w-max">
                                        {row.shelf}
                                    </Badge>
                                </TableCell>
                                <TableCell>
                                    <ButtonGroup outline>
                                        <Button color="blue">
                                            <Link
                                                href={`/dashboard/books/${row.id}`}
                                            >
                                                View
                                            </Link>
                                        </Button>
                                        <Button
                                            color="failure"
                                            onClick={() =>
                                                deleteHandler(row.id)
                                            }
                                        >
                                            Delete
                                        </Button>
                                    </ButtonGroup>
                                </TableCell>
                            </TableRow>
                        ))}
                    {rows.length === 0 && (
                        <TableRow>
                            <TableCell colSpan={columns.length + 1}>
                                <NoData
                                    title="There is no books yet"
                                    subtitle="You can add a new book to your collection"
                                    href="/dashboard/books/add"
                                    linkTitle="Add a book"
                                />
                            </TableCell>
                        </TableRow>
                    )}
                </TableBody>
            </Table>
            <DeleteConfirm
                open={openModal}
                setOpen={setOpenModal}
                setResult={setResult}
            />
        </>
    );
};

export default ListTableView;
