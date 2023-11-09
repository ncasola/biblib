"use server";

import { Book, PersonalBook, Shelf } from "@/app/models";
import type { IBook } from "@/app/models/Book.model";
import OpenLibrary from "@/app/sdk/OpenLibrary";
import type { PersonalBookDTO } from "@/app/types/Book.types";

export const createBook = async (data: PersonalBookDTO) => {
    const { isbn, user, shelf, status } = data;
    const booksCreated: IBook[] = [];
    const searchBook: IBook | null = await Book.findOne({ isbn });
    if (searchBook) {
        booksCreated.push(searchBook);
    } else {
        const openLibrary = new OpenLibrary();
        const edition = await openLibrary.searchBookByISBN(isbn);
        if (!edition) {
            return { error: "Book not found" };
        }
        const newBook: IBook = new Book({
            isbn,
            data: edition,
        });
        const bookCreated = await newBook.save();
        booksCreated.push(bookCreated);
    }
    const newPersonalBook = new PersonalBook({
        book: booksCreated[0]._id,
        title: booksCreated[0].data.title,
        user,
        status,
        shelf,
    });
    const personalBookCreated = await newPersonalBook.save();
    return personalBookCreated;
};

export const getBookByISBN = async (isbn: string) => {
    const openLibrary = new OpenLibrary();
    const edition = await openLibrary.searchBookByISBN(isbn);
    if (!edition) {
        return { error: "Book not found" };
    }
    return edition;
};

export const createShelf = async ({
    title,
    user,
}: {
    title: string;
    user: string;
}) => {
    const newShelf = new Shelf({
        title,
        user,
    });
    const shelfCreated = await newShelf.save();
    return shelfCreated;
};
