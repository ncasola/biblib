import mongoose from "mongoose";

import type { IBook } from "./Book.model";
import BookSchema from "./Book.model";
import type { IPersonalBook } from "./PersonalBook.model";
import PersonalBookSchema from "./PersonalBook.model";
import type { IShelf } from "./Shelf.model";
import ShelfSchema from "./Shelf.model";

const Book = mongoose.models.Book || mongoose.model<IBook>("Book", BookSchema);
const PersonalBook =
    mongoose.models.PersonalBook ||
    mongoose.model<IPersonalBook>("PersonalBook", PersonalBookSchema);
const Shelf =
    mongoose.models.Shelf || mongoose.model<IShelf>("Shelf", ShelfSchema);

export { Book, PersonalBook, Shelf };
