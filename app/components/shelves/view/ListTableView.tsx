import { Table } from "flowbite-react";

import { NoData } from "@/app/components/NoData";
import type { ShelfItem } from "@/app/types/Shelf.types";

interface Props {
    data: ShelfItem[];
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
                            <Table.Cell>{row.totalBooks}</Table.Cell>
                        </Table.Row>
                    ))}
                {rows.length === 0 && (
                    <Table.Row>
                        <Table.Cell colSpan={columns.length}>
                            <NoData
                                title="There is no shelves yet"
                                subtitle="You can add a new Shelf"
                                href="/dashboard/shelves/add"
                                linkTitle="Add a Shelf"
                            />
                        </Table.Cell>
                    </Table.Row>
                )}
            </Table.Body>
        </Table>
    );
};

export default ListTableView;
