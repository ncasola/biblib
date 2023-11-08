import mongoose from "mongoose";

export interface IShelf extends mongoose.Document {
    _id: mongoose.Types.ObjectId;
    user: string;
    title: string;
    books: number;
    createdAt: Date;
    updatedAt: Date;
}

const ShelfSchema = new mongoose.Schema(
    {
        title: { type: String, required: true },
        user: { type: String, required: true },
    },
    {
        timestamps: true,
    },
);

export default ShelfSchema;
