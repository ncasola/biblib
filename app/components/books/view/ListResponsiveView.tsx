import { Button, Table } from "flowbite-react";
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
                        <a
                            href="/dashboard/books/add"
                            className="inline-flex items-center px-4 py-2 border border-transparent text-base font-medium rounded-md shadow-sm text-white bg-indigo-600 hover:bg-indigo-700 dark:bg-gray-800 dark:hover:bg-gray-700"
                        >
                            Add a book
                        </a>
                    </div>
                </div>
            ) : (
                <main className="grid grid-cols-1 gap-2">
                    {props.data.map((book) => (
                        <Table key={book.id} striped>
                            <Table.Head>
                                <Table.HeadCell>
                                    <span className="font-bold text-gray-700 dark:text-gray-300">
                                        Field
                                    </span>
                                </Table.HeadCell>
                                <Table.HeadCell>
                                    <span className="font-bold text-gray-700 dark:text-gray-300">
                                        Data
                                    </span>
                                </Table.HeadCell>
                            </Table.Head>
                            <Table.Body>
                                <Table.Row>
                                    <Table.Cell>
                                        <span className="font-bold text-gray-700 dark:text-gray-300">
                                            Title
                                        </span>
                                    </Table.Cell>
                                    <Table.Cell>{book.title}</Table.Cell>
                                </Table.Row>
                                <Table.Row>
                                    <Table.Cell>
                                        <span className="font-bold text-gray-700 dark:text-gray-300">
                                            Shelf
                                        </span>
                                    </Table.Cell>
                                    <Table.Cell>{book.shelf}</Table.Cell>
                                </Table.Row>
                                <Table.Row>
                                    <Table.Cell>
                                        <span className="font-bold text-gray-700 dark:text-gray-300">
                                            Publish Date
                                        </span>
                                    </Table.Cell>
                                    <Table.Cell>{book.publishDate}</Table.Cell>
                                </Table.Row>
                                <Table.Row>
                                    <Table.Cell>
                                        <Button color="blue">
                                            <Link
                                                href={`/dashboard/books/${book.id}`}
                                            >
                                                View
                                            </Link>
                                        </Button>
                                    </Table.Cell>
                                    <Table.Cell>
                                        <Button color="failure">Delete</Button>
                                    </Table.Cell>
                                </Table.Row>
                            </Table.Body>
                        </Table>
                    ))}
                </main>
            )}
        </div>
    );
};

export default ListResponsiveView;
