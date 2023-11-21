"use client";

import { Card } from "flowbite-react";
import Image from "next/image";
import Link from "next/link";
import { HiArrowRight } from "react-icons/hi";

type Props = {
    title: string;
    href: string;
    image: string;
    description: string;
};

export const CardInfo = (props: Props) => {
    const { title, href, image, description } = props;
    return (
        <Card className="w-full h-full flex flex-col justify-between">
            <h5 className="text-2xl text-center font-bold tracking-tight text-gray-900 dark:text-white">
                {title}
            </h5>
            <div className="flex justify-center">
                <Image
                    src={image}
                    alt={title}
                    width={200}
                    height={300}
                    className="rounded-lg shadow-md"
                />
            </div>
            <p className="text-center text-gray-700 dark:text-gray-300">
                {description}
            </p>
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
