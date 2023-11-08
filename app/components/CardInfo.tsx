"use client";

import { Card } from "flowbite-react";
import Link from "next/link";
import { HiArrowRight } from "react-icons/hi";

type Props = {
    title: string;
    href: string;
};

export const CardInfo = (props: Props) => {
    const { title, href } = props;
    return (
        <Card className="max-w-sm">
            <h5 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">
                {title}
            </h5>
            <Link
                href={href}
                className="inline-flex items-center justify-center rounded-lg bg-gray-200 px-3 py-2 text-xs font-medium text-gray-900 hover:bg-gray-300 focus:outline-none focus:ring-4 focus:ring-gray-300 dark:bg-gray-600 dark:hover:bg-gray-700 dark:focus:ring-gray-800"
            >
                Access
                <HiArrowRight className="ml-2 h-4 w-4" />
            </Link>
        </Card>
    );
};
