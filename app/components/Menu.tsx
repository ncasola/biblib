"use client";

import { Avatar, Dropdown, Flowbite, Navbar } from "flowbite-react";
import { signIn, signOut, useSession } from "next-auth/react";

type Props = {};

export const Menu = (props: Props) => {
    const { data: session, status } = useSession();
    const user = session && session.user ? session.user : null;
    const attributes = {
        name: user && user.name ? user.name : "No name",
        image:
            user && user.image
                ? user.image
                : "https://flowbite.com/docs/images/people/profile-picture-5.jpg",
        email: user && user.email ? user.email : "No email",
    };
    return (
        <Flowbite>
            <main className="flex justify-center items-center">
                <Navbar className="w-11/12 h-5/6 md:w-9/12 md:h-5/6">
                    <Navbar.Brand
                        href={`${process.env.NEXT_PUBLIC_ABSOLUTE_URL}`}
                    >
                        <span className="self-center whitespace-nowrap text-xl font-semibold dark:text-white">
                            BibLib
                        </span>
                    </Navbar.Brand>
                    {status === "loading" ? <div>Loading...</div> : null}
                    {session ? (
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
                            <div className="flex md:order-2">
                                <Dropdown
                                    arrowIcon={false}
                                    inline
                                    label={
                                        <Avatar
                                            alt={attributes.name}
                                            img={attributes.image}
                                            rounded
                                        />
                                    }
                                >
                                    <Dropdown.Header>
                                        <span className="block text-sm">
                                            {attributes.name}
                                        </span>
                                        <span className="block truncate text-sm font-medium">
                                            {attributes.email}
                                        </span>
                                    </Dropdown.Header>
                                    <Dropdown.Item onClick={() => signOut()}>
                                        Sign out
                                    </Dropdown.Item>
                                </Dropdown>
                                <Navbar.Toggle />
                            </div>
                        </>
                    ) : (
                        <Navbar.Collapse>
                            <Navbar.Link
                                className="md:order-2"
                                onClick={() => signIn()}
                            >
                                Sign in
                            </Navbar.Link>
                        </Navbar.Collapse>
                    )}
                </Navbar>
            </main>
        </Flowbite>
    );
};
