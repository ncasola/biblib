import { Command } from "commander";

import { connectToDb } from "./config/connectToDb";
import { Book, PersonalBook, Shelf } from "./models";
import type { IBook } from "./models/Book.model";
import type { IPersonalBook } from "./models/PersonalBook.model";
import type { IShelf } from "./models/Shelf.model";
import OpenLibrary from "./sdk/OpenLibrary";

const program = new Command();

program.version("0.0.1").description("A CLI for seed project");

program
    .command("gen:books")
    .alias("gb")
    .description("Generate books")
    .action(async () => {
        await connectToDb();
        // generate shelves
        const user = "ncasolajimenez@gmail.com";
        const names = ["Want to read", "Currently reading", "Read"];
        const shelvesIds: string[] = [];
        names.forEach(async (name) => {
            const shelf: IShelf | null = await Shelf.findOne({ title: name });
            if (!shelf) {
                const newShelf = new Shelf({
                    title: name,
                    user,
                });
                const shelfCreated = await newShelf.save();
                shelvesIds.push(shelfCreated.id);
            }
        });
        console.log(`Shelves created: ${shelvesIds.length}`);
        // generate books
        const openLibrary = new OpenLibrary();
        const isbnList = [
            "9788467217681",
            "9788401375392",
            "9789590804465",
            "9788401022166",
            "9788401022166",
            "9788401022166",
            "9788401017377",
            "9788419374660",
            "9788467247961",
            "9788467241068",
            "9788420733838",
            "9788408054078",
            "9788432136580",
            "9788432134746",
            "9788432136306",
            "9788467224542",
            "9788432134555",
            "9788428811118",
            "9788498721959",
            "9788432110023",
            "9788466638180",
        ];
        const booksCreated: IPersonalBook[] = [];
        for (const isbn of isbnList) {
            const searchBook: IBook | null = await Book.findOne({ isbn });
            if (!searchBook) {
                const edition = await openLibrary.searchBookByISBN(isbn);
                if (!edition) {
                    continue;
                }
                const newBook = new Book({
                    isbn,
                    data: edition,
                });
                const bookCreated = await newBook.save();
                const randomIndex =
                    Math.floor(
                        Math.random() * (shelvesIds.length - 1 - 0 + 1),
                    ) + 0;
                const newPersonalBook = new PersonalBook({
                    book: bookCreated._id,
                    title: bookCreated.data.title,
                    user,
                    status: "read",
                    shelf: shelvesIds[randomIndex],
                });
                const personalBookCreated = await newPersonalBook.save();
                booksCreated.push(personalBookCreated);
            }
        }
        console.log(`Books created: ${booksCreated.length}`);
        console.log(booksCreated.join("\n"));
        console.log("Done!");
    });

program.parse(process.argv);
