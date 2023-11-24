"use client";

import { ErrorMessage } from "@hookform/error-message";
import { zodResolver } from "@hookform/resolvers/zod";
import { Alert, Button, Label, TextInput } from "flowbite-react";
import { useState } from "react";
import { SubmitHandler, useForm } from "react-hook-form";
import z from "zod";

import { createShelf } from "@/app/actions";

const validationSchema = z.object({
    title: z.string().min(3).max(50),
});

type ValidationSchema = z.infer<typeof validationSchema>;

export default function AddShelfForm() {
    const [loading, setLoading] = useState(false);
    const [message, setMessage] = useState("");
    const {
        register,
        handleSubmit,
        formState: { errors },
    } = useForm<ValidationSchema>({
        resolver: zodResolver(validationSchema),
    });
    const onSubmit: SubmitHandler<ValidationSchema> = async (data) => {
        setLoading(true);
        const newShelf = await createShelf(data);
        if (newShelf instanceof Object && "error" in newShelf) {
            setMessage(newShelf.error);
        } else {
            setMessage(`Shelf added successfully`);
        }
        setLoading(false);
    };
    return (
        <form
            className="flex w-full flex-col gap-4 p-4 border-2 border-gray-200 rounded-lg bg-white dark:bg-gray-800"
            onSubmit={handleSubmit(onSubmit)}
        >
            <div>
                <div className="mb-2 block">
                    <Label htmlFor="Title" value="Title" />
                </div>
                <TextInput
                    type="text"
                    placeholder="Title"
                    {...register("title", {
                        required: true,
                    })}
                />
                <ErrorMessage
                    errors={errors}
                    name="title"
                    render={({ message }) => <p>{message}</p>}
                />
            </div>

            <Button type="submit" isProcessing={loading} pill>
                Add Shelf
            </Button>
            {message && (
                <Alert color="success" className="mt-4">
                    {message}
                </Alert>
            )}
        </form>
    );
}
