"use client";

import { Banner } from "flowbite-react";
import Link from "next/link";
import { HiArrowRight } from "react-icons/hi";

type Props = {
    title: string;
    subtitle: string;
    href: string;
    linkTitle: string;
};

export const NoData = (props: Props) => {
    const { title, subtitle, href, linkTitle } = props;
    return (
        <Banner>
            <div className="flex w-full flex-col justify-between border-b border-gray-200 bg-gray-50 p-4 dark:border-gray-600 dark:bg-gray-700 md:flex-row">
                <div className="mb-4 md:mb-0 md:mr-4">
                    <h2 className="mb-1 text-base font-semibold text-gray-900 dark:text-white">
                        {title}
                    </h2>
                    <p className="flex items-center text-sm font-normal text-gray-500 dark:text-gray-400">
                        {subtitle}
                    </p>
                </div>
                <div className="flex flex-shrink-0 items-center">
                    <Link
                        href={href}
                        className="inline-flex items-center justify-center rounded-lg bg-gray-200 px-3 py-2 text-xs font-medium text-gray-900 hover:bg-gray-300 focus:outline-none focus:ring-4 focus:ring-gray-300 dark:bg-gray-600 dark:hover:bg-gray-700 dark:focus:ring-gray-800"
                    >
                        {linkTitle}
                        <HiArrowRight className="ml-2 h-4 w-4" />
                    </Link>
                </div>
            </div>
        </Banner>
    );
};
