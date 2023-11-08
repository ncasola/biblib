"use client";

import { ListGroup } from "flowbite-react";
import React from "react";

import type { Isbn } from "@/app/schemas/Isbn.schema";

interface Props {
    data: Isbn;
}

const TableDetails: React.FC<Props> = ({ data }) => {
    const title = data.title.slice(0, 50);
    const trimmedTitle =
        title.length < data.title.length ? `${title}...` : title;
    return (
        <div className="flex justify-center">
            <ListGroup className="w-48">
                <ListGroup.Item>
                    <strong>ISBN:</strong> {data.identifiers.isbn_10}
                </ListGroup.Item>
                <ListGroup.Item>
                    <strong>Title:</strong> {trimmedTitle}
                </ListGroup.Item>
            </ListGroup>
        </div>
    );
};

export default TableDetails;
