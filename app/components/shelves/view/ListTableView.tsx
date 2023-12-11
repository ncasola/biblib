import { useAutoAnimate } from "@formkit/auto-animate/react";
import { Button, Table } from "flowbite-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { deleteShelf } from "@/app/actions";
import { DeleteConfirm } from "@/app/components/layout/DeleteConfirm";
import { NoData } from "@/app/components/layout/NoData";
import type { ShelfItem } from "@/app/types/Shelf.types";

interface Props {
    data: ShelfItem[];
    columns: string[];
}

const ListTableView = (props: Props) => {
    const router = useRouter();
    const [parent, enableAnimations] = useAutoAnimate();
    const [openModal, setOpenModal] = useState(false);
    const [result, setResult] = useState(false);
    const [shelfToDelete, setShelfToDelete] = useState<string | null>(null);
    const defaultShelves = ["Want to read", "Currently reading", "Read"];
    const deleteHandler = (id: string) => {
        setOpenModal(true);
        setShelfToDelete(id);
    };
    useEffect(() => {
        const deleteShelfHandler = async (bookToDelete: string) => {
            const deleted = await deleteShelf(bookToDelete);
            return deleted;
        };
        if (shelfToDelete && result) {
            console.log("bookToDelete", shelfToDelete);
            deleteShelfHandler(shelfToDelete);
            setShelfToDelete(null);
            setResult(false);
            router.refresh();
        }
    }, [result, shelfToDelete, router]);
    const { data: rows, columns } = props;
    return (
        <>
            <Table ref={parent}>
                <Table.Head>
                    <>
                        {columns.map((column) => (
                            <Table.HeadCell key={column}>
                                {column}
                            </Table.HeadCell>
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
                                <Table.Cell>{row.totalBooks}</Table.Cell>
                                <Table.Cell>
                                    <Button.Group outline>
                                        <Button color="blue">
                                            <Link
                                                href={`/dashboard/books?page=1&pageSize=5&shelf=${row.id}`}
                                            >
                                                View
                                            </Link>
                                        </Button>
                                        {!defaultShelves.includes(row.title) ? (
                                            <Button
                                                color="failure"
                                                onClick={() =>
                                                    deleteHandler(row.id)
                                                }
                                            >
                                                Delete
                                            </Button>
                                        ) : (
                                            <Button disabled>Delete</Button>
                                        )}
                                    </Button.Group>
                                </Table.Cell>
                            </Table.Row>
                        ))}
                    {rows.length === 0 && (
                        <Table.Row>
                            <Table.Cell colSpan={columns.length + 1}>
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
            <DeleteConfirm
                open={openModal}
                setOpen={setOpenModal}
                setResult={setResult}
            />
        </>
    );
};

export default ListTableView;
