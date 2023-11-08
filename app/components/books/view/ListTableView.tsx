import { Table } from "flowbite-react";
import Image from "next/image";

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
                                />
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
