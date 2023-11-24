/* eslint-disable simple-import-sort/imports */
"use client";

import { SignInButton, SignedIn, SignedOut, UserButton } from "@clerk/nextjs";
import { Flowbite, Navbar } from "flowbite-react";
import Image from "next/image";

export const Menu = () => {
    return (
        <Flowbite>
            <main className="flex justify-center items-center bg-white">
                <Navbar className="w-11/12 h-5/6 md:w-9/12 md:h-5/6">
                    <Navbar.Brand
                        href={`${process.env.NEXT_PUBLIC_ABSOLUTE_URL}`}
                    >
                        <Image
                            src="/logo.png"
                            alt="BibLib"
                            width={50}
                            height={50}
                        />
                        <span className="self-center whitespace-nowrap text-xl font-semibold dark:text-white">
                            BibLib
                        </span>
                    </Navbar.Brand>
                    <SignedIn>
                        <Navbar.Collapse>
                            <Navbar.Link
                                className="md:order-2"
                                href={`${process.env.NEXT_PUBLIC_ABSOLUTE_URL}/dashboard`}
                            >
                                Dashboard
                            </Navbar.Link>
                            <Navbar.Link
                                className="md:order-2"
                                href={`${process.env.NEXT_PUBLIC_ABSOLUTE_URL}/dashboard/books`}
                            >
                                Books
                            </Navbar.Link>
                            <Navbar.Link
                                className="md:order-2"
                                href={`${process.env.NEXT_PUBLIC_ABSOLUTE_URL}/dashboard/shelves`}
                            >
                                Shelves
                            </Navbar.Link>
                        </Navbar.Collapse>
                        <UserButton />
                    </SignedIn>
                    <SignedOut>
                        <SignInButton />
                    </SignedOut>
                </Navbar>
            </main>
        </Flowbite>
    );
};
