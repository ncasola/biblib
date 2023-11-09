"use client";

import { ErrorMessage } from "@hookform/error-message";
import { zodResolver } from "@hookform/resolvers/zod";
import {
    Alert,
    Button,
    Label,
    Select,
    Spinner,
    TextInput,
} from "flowbite-react";
import { useState } from "react";
import { SubmitHandler, useForm } from "react-hook-form";
import z from "zod";

import { createBook } from "@/app/actions";
import { usePrvBookStore } from "@/app/stores/PrvBookStore";

const validationSchema = z.object({
    isbn: z.string().max(13).min(13).max(13),
    status: z.string(),
    user: z.string().max(200).min(5).max(200),
    shelf: z.string().max(200).min(5).max(200),
});

type ValidationSchema = z.infer<typeof validationSchema>;

type Props = {
    shelves: { value: string; label: string }[];
    user: string;
};

export default function AddBookForm(props: Props) {
    const { shelves, user } = props;
    const prvBook = usePrvBookStore();
    const [message, setMessage] = useState("");
    const [loading, setLoading] = useState(false);
    const {
        register,
        handleSubmit,
        formState: { errors },
    } = useForm<ValidationSchema>({
        resolver: zodResolver(validationSchema),
        defaultValues: {
            user,
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
    return (
        <form
            className="flex max-w-md flex-col gap-4 p-4 border-2 border-gray-200 rounded-lg"
            onSubmit={handleSubmit(onSubmit)}
        >
            <div>
                <div className="mb-2 block">
                    <Label htmlFor="ISBN" value="ISBN" />
                </div>
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
                        prvBook.replaceBook(e.target.value);
                    }}
                />
                <ErrorMessage
                    errors={errors}
                    name="isbn"
                    render={({ message }) => <p>{message}</p>}
                />
            </div>
            <div>
                <div className="mb-2 block">
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
            </div>
            <div>
                <div className="mb-2 block">
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
            </div>
            <input type="hidden" {...register("user")} />

            <Button type="submit">
                {loading ? (
                    <>
                        <Spinner
                            aria-label="Spinner button example"
                            size="sm"
                        />
                        <span className="pl-3">Loading...</span>
                    </>
                ) : (
                    "Add Book"
                )}
            </Button>
            {message && (
                <Alert color="success" className="mt-4">
                    {message}
                </Alert>
            )}
        </form>
    );
}
