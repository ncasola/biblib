"use client";

import { Toast, ToastToggle } from "flowbite-react";
import { useEffect } from "react";
import { HiCheck } from "react-icons/hi";

import { useToastStore } from "@/app/stores/ToastStore";

const ToastItem = () => {
    const { message, color, clearToast } = useToastStore();
    useEffect(() => {
        if (message) {
            const timeout = setTimeout(() => {
                clearToast();
            }, 5000);

            return () => {
                clearTimeout(timeout);
            };
        }
    }, [message, clearToast]);
    return (
        <div className="flex flex-col gap-4 mt-4">
            {message && (
                <Toast>
                    <div
                        className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-${color}-100 text-${color}-500 dark:bg-${color}-800 dark:text-${color}-200`}
                    >
                        <HiCheck className="h-5 w-5" />
                    </div>
                    <div className="ml-3 text-sm font-normal">{message}</div>
                    <ToastToggle onClick={clearToast} className="ml-auto" />
                </Toast>
            )}
        </div>
    );
};

export default ToastItem;
