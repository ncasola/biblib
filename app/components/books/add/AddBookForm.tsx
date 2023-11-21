"use client";

import { ErrorMessage } from "@hookform/error-message";
import { zodResolver } from "@hookform/resolvers/zod";
import { Alert, Button, Label, Select, TextInput } from "flowbite-react";
import { useEffect, useState } from "react";
import { SubmitHandler, useForm } from "react-hook-form";
import { useDebounce } from "use-debounce";
import z from "zod";

import { createBook, getShelvesCurrentUser } from "@/app/actions";
import { ShelfSelect } from "@/app/types/Shelf.types";

import PreviewBook from "./PreviewBook";

const validationSchema = z.object({
    isbn: z.string().max(13).min(13).max(13),
    status: z.string(),
    shelf: z.string().max(200).min(5).max(200),
});

type ValidationSchema = z.infer<typeof validationSchema>;
export default function AddBookForm() {
    const [actualIsbn, setActualIsbn] = useState("");
    const [debouncedIsbn] = useDebounce(actualIsbn, 1000);
    useEffect(() => {
        setIsbn(debouncedIsbn);
    }, [debouncedIsbn]);
    const [message, setMessage] = useState("");
    const [loading, setLoading] = useState(false);
    const [shelves, setShelves] = useState<ShelfSelect[]>([]);
    const [isbn, setIsbn] = useState("");
    const {
        register,
        handleSubmit,
        formState: { errors },
    } = useForm<ValidationSchema>({
        resolver: zodResolver(validationSchema),
        defaultValues: {
            status: "reading",
        },
    });
    const onSubmit: SubmitHandler<ValidationSchema> = async (data) => {
        setLoading(true);
        const newBook = await createBook(data);
        if (newBook instanceof Object && "error" in newBook) {
            setMessage(newBook.error);
        } else {
            setMessage(`Book added successfully`);
        }
        setLoading(false);
    };
    useEffect(() => {
        const getShelves = async () => {
            const shelves = await getShelvesCurrentUser();
            setShelves(shelves);
        };
        getShelves();
    }, []);
    return (
        <form
            className="flex w-full flex-col gap-2 p-4 border-2 border-gray-200 rounded-lg bg-white dark:bg-gray-800"
            onSubmit={handleSubmit(onSubmit)}
        >
            <Label htmlFor="ISBN" value="ISBN" />
            <div className="grid grid-cols-[2fr_1fr] gap-2">
                <TextInput
                    type="text"
                    placeholder="ISBN"
                    {...register("isbn", {
                        required: true,
                        max: 13,
                        min: 13,
                        maxLength: 13,
                    })}
                    onChange={(e) => {
                        setActualIsbn(e.target.value);
                    }}
                />
                <ErrorMessage
                    errors={errors}
                    name="isbn"
                    render={({ message }) => <p>{message}</p>}
                />
                <PreviewBook isbn={isbn} />
            </div>
            <div className="block">
                <Label htmlFor="Status" value="Status" />
            </div>
            <Select {...register("status")}>
                <option value="reading">Reading</option>
                <option value="read">Read</option>
                <option value="to-read">To-Read</option>
                <option value="unread">Unread</option>
            </Select>
            <ErrorMessage
                errors={errors}
                name="status"
                render={({ message }) => <p>{message}</p>}
            />
            <div className="block">
                <Label htmlFor="Shelf" value="Shelf" />
            </div>
            <Select {...register("shelf")}>
                {shelves.map((shelf) => (
                    <option key={shelf.value} value={shelf.value}>
                        {shelf.label}
                    </option>
                ))}
            </Select>
            <ErrorMessage
                errors={errors}
                name="shelf"
                render={({ message }) => <p>{message}</p>}
            />

            <Button type="submit" isProcessing={loading} pill>
                Add Book
            </Button>
            {message && (
                <Alert color="success" className="mt-4">
                    {message}
                </Alert>
            )}
        </form>
    );
}
