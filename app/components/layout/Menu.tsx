/* eslint-disable simple-import-sort/imports */
"use client";

import { Button, Flowbite, Navbar } from "flowbite-react";
import type { Session } from "next-auth";
import { signIn } from "next-auth/react";
import Image from "next/image";
import SignedDropdown from "./SignedDropdown";

type Props = {
    session: Session | null;
};

export const Menu = (props: Props) => {
    const session = props.session;
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
                    {session && (
                        <>
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
                            <SignedDropdown session={session} />
                        </>
                    )}
                    {!session && (
                        <Navbar.Collapse>
                            <Button
                                className="md:order-2"
                                onClick={() => signIn()}
                            >
                                Login
                            </Button>
                        </Navbar.Collapse>
                    )}
                </Navbar>
            </main>
        </Flowbite>
    );
};
