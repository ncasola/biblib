import mongoose from "mongoose";

import type { Isbn } from "@/app/schemas/Isbn.schema";

export interface IBook extends mongoose.Document {
    _id: mongoose.Types.ObjectId;
    isbn: string;
    data: Isbn;
    createdAt: Date;
    updatedAt: Date;
}

const BookSchema = new mongoose.Schema<IBook>(
    {
        isbn: { type: String, required: true },
        data: { type: Object, required: true },
    },
    { timestamps: true },
);

export default BookSchema;
