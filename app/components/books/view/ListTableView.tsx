import { Table } from "flowbite-react";
import Image from "next/image";
import Link from "next/link";

import { NoData } from "@/app/components/NoData";
import type { BookItem } from "@/app/types/Book.types";

interface Props {
    data: BookItem[];
    columns: string[];
}

const ListTableView = (props: Props) => {
    const { data: rows, columns } = props;
    return (
        <Table>
            <Table.Head>
                <>
                    {columns.map((column) => (
                        <Table.HeadCell key={column}>{column}</Table.HeadCell>
                    ))}
                </>
                <Table.HeadCell>Actions</Table.HeadCell>
            </Table.Head>
            <Table.Body>
                {rows &&
                    rows.map((row) => (
                        <Table.Row
                            className="bg-white border-b dark:bg-gray-800 dark:border-gray-700"
                            key={row.id}
                        >
                            <Table.Cell>{row.title}</Table.Cell>
                            <Table.Cell>{row.publishDate}</Table.Cell>
                            <Table.Cell>
                                <Image
                                    src={row.image}
                                    alt={row.title}
                                    width={50}
                                    height={50}
                                    className="rounded-lg shadow-md"
                                />
                            </Table.Cell>
                            <Table.Cell>{row.shelf}</Table.Cell>
                            <Table.Cell>
                                <Link
                                    href={`/dashboard/books/${row.id}`}
                                    className="inline-flex items-center justify-center rounded-lg bg-gray-200 px-3 py-2 text-xs font-medium text-gray-900 hover:bg-gray-300 focus:outline-none focus:ring-4 focus:ring-gray-300 dark:bg-gray-600 dark:hover:bg-gray-700 dark:focus:ring-gray-800"
                                >
                                    View
                                </Link>
                            </Table.Cell>
                        </Table.Row>
                    ))}
                {rows.length === 0 && (
                    <Table.Row>
                        <Table.Cell colSpan={columns.length}>
                            <NoData
                                title="There is no books yet"
                                subtitle="You can add a new book to your collection"
                                href="/dashboard/books/add"
                                linkTitle="Add a book"
                            />
                        </Table.Cell>
                    </Table.Row>
                )}
            </Table.Body>
        </Table>
    );
};

export default ListTableView;
