import {
    Button,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeadCell,
    TableRow,
} from "flowbite-react";
import Link from "next/link";

import type { BookItem } from "@/app/types/Book.types";

interface Props {
    data: BookItem[];
}

const ListResponsiveView = (props: Props) => {
    return (
        <div className="flex flex-col gap-4">
            {props.data.length === 0 ? (
                <div className="flex flex-col gap-4">
                    <div className="flex flex-col gap-4">
                        <h1 className="text-2xl font-bold text-gray-800 dark:text-gray-100">
                            There is no books yet
                        </h1>
                        <p className="text-gray-600 dark:text-gray-300">
                            You can add a new book to your collection
                        </p>
                    </div>
                    <div className="flex flex-col gap-4">
                        <Link
                            href="/dashboard/books/add"
                            className="inline-flex items-center px-4 py-2 border border-transparent text-base font-medium rounded-md shadow-sm text-white bg-indigo-600 hover:bg-indigo-700 dark:bg-gray-800 dark:hover:bg-gray-700"
                        >
                            Add a book
                        </Link>
                    </div>
                </div>
            ) : (
                <main className="grid grid-cols-1 gap-2">
                    {props.data.map((book) => (
                        <Table key={book.id} striped>
                            <TableHead>
                                <TableHeadCell>
                                    <span className="font-bold text-gray-700 dark:text-gray-300">
                                        Field
                                    </span>
                                </TableHeadCell>
                                <TableHeadCell>
                                    <span className="font-bold text-gray-700 dark:text-gray-300">
                                        Data
                                    </span>
                                </TableHeadCell>
                            </TableHead>
                            <TableBody>
                                <TableRow>
                                    <TableCell>
                                        <span className="font-bold text-gray-700 dark:text-gray-300">
                                            Title
                                        </span>
                                    </TableCell>
                                    <TableCell>{book.title}</TableCell>
                                </TableRow>
                                <TableRow>
                                    <TableCell>
                                        <span className="font-bold text-gray-700 dark:text-gray-300">
                                            Shelf
                                        </span>
                                    </TableCell>
                                    <TableCell>{book.shelf}</TableCell>
                                </TableRow>
                                <TableRow>
                                    <TableCell>
                                        <span className="font-bold text-gray-700 dark:text-gray-300">
                                            Publish Date
                                        </span>
                                    </TableCell>
                                    <TableCell>{book.publishDate}</TableCell>
                                </TableRow>
                                <TableRow>
                                    <TableCell>
                                        <Button color="blue">
                                            <Link
                                                href={`/dashboard/books/${book.id}`}
                                            >
                                                View
                                            </Link>
                                        </Button>
                                    </TableCell>
                                    <TableCell>
                                        <Button color="failure">Delete</Button>
                                    </TableCell>
                                </TableRow>
                            </TableBody>
                        </Table>
                    ))}
                </main>
            )}
        </div>
    );
};

export default ListResponsiveView;
