import mongoose from "mongoose";

import type { IBook } from "./Book.model";
import type { IShelf } from "./Shelf.model";

enum Status {
    "read",
    "reading",
    "unread",
    "to-read",
}

export interface IPersonalBook extends mongoose.Document {
    _id: mongoose.Types.ObjectId;
    book: IBook;
    title: string;
    user: string;
    status: string;
    shelf: IShelf;
    createdAt: Date;
    updatedAt: Date;
}

const PersonalBookSchema = new mongoose.Schema<IPersonalBook>(
    {
        book: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Book",
            required: true,
        },
        shelf: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Shelf",
            required: true,
        },
        title: {
            type: String,
            required: true,
            index: true,
            text: true,
            trim: true,
        },
        user: { type: String, required: true },
        status: { type: String, enum: Status, required: true },
    },
    { timestamps: true },
);

export default PersonalBookSchema;
