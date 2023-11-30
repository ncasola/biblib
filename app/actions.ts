"use server";

import { revalidatePath } from "next/cache";

import { connectToDb } from "@/app/config/connectToDb";
import { Book, PersonalBook, Shelf } from "@/app/models";
import type { IBook } from "@/app/models/Book.model";
import type { IPersonalBook } from "@/app/models/PersonalBook.model";
import { IShelf } from "@/app/models/Shelf.model";
import OpenLibrary from "@/app/sdk/OpenLibrary";
import type { PersonalBookDTO } from "@/app/types/Book.types";
import { auth } from "@/auth";

export const getCurrentUser = async () => {
    const session = await auth();
    if (!session) {
        throw new Error("User not found");
    }
    const user = session.user;
    return user?.email as string;
};

export const createBook = async (data: PersonalBookDTO) => {
    await connectToDb();
    const user = await getCurrentUser();
    const { isbn, shelf, status } = data;
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
    // check if book already exists in personal library
    const searchPersonalBook: IPersonalBook | null = await PersonalBook.findOne(
        {
            book: booksCreated[0]._id,
            user,
        },
    );
    if (searchPersonalBook) {
        return { error: "Book already exists in your library" };
    }
    const newPersonalBook = new PersonalBook({
        book: booksCreated[0]._id,
        title: booksCreated[0].data.title,
        user,
        status,
        shelf,
    });
    const personalBookCreated = await newPersonalBook.save();
    revalidatePath("/dashboard/books");
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

export const deleteBook = async (id: string) => {
    await connectToDb();
    await PersonalBook.findByIdAndDelete(id);
    revalidatePath("/dashboard/books");
    return true;
};

export const createShelf = async ({ title }: { title: string }) => {
    await connectToDb();
    const user = await getCurrentUser();
    const newShelf = new Shelf({
        title,
        user,
    });
    const shelfCreated = await newShelf.save();
    revalidatePath("/dashboard/shelves");
    return shelfCreated;
};

export const getShelvesCurrentUser = async () => {
    await connectToDb();
    const user = await getCurrentUser();
    const data: IShelf[] = await Shelf.find({ user });
    const shelves = data.map((shelf) => {
        return {
            value: shelf.id,
            label: shelf.title,
        };
    });
    return shelves;
};

export const changeShelf = async (id: string, shelf: string) => {
    await connectToDb();
    const user = await getCurrentUser();
    const book = await PersonalBook.findById(id);
    if (!book) {
        return { error: "Book not found" };
    }
    if (book.user !== user) {
        return { error: "You don't have permission to change this book" };
    }
    book.shelf = shelf;
    await book.save();
    revalidatePath("/dashboard/shelves");
    return true;
};

export const deleteShelf = async (id: string) => {
    await connectToDb();
    // defaults shelves can't be deleted
    const defaultShelves = ["Want to read", "Currently reading", "Read"];
    const shelfToDelete: IShelf | null = await Shelf.findById(id);
    if (!shelfToDelete) {
        return { error: "Shelf not found" };
    }
    if (defaultShelves.includes(shelfToDelete.title)) {
        return { error: "Default shelves can't be deleted" };
    }
    const books: IPersonalBook[] = await PersonalBook.find({ shelf: id });
    if (books.length === 0) {
        await Shelf.findByIdAndDelete(id);
        return true;
    } else if (books.length > 0) {
        const defaultShelf = await Shelf.findOne({
            user: books[0].user,
            title: "Want to read",
        });
        if (!defaultShelf) {
            return { error: "Default shelf not found" };
        }
        for (const book of books) {
            book.shelf = defaultShelf.id;
            await book.save();
        }
        await Shelf.findByIdAndDelete(id);
        revalidatePath("/dashboard/shelves");
        return true;
    }
};
