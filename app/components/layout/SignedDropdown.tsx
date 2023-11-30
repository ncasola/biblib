"use client";

import { Avatar, Dropdown, Navbar } from "flowbite-react";
import { Session } from "next-auth";
import { signOut } from "next-auth/react";

type Props = {
    session: Session | null;
};

const SignedDropdown = ({ session }: Props) => {
    console.log("session", session);
    const name = session?.user?.name as string;
    const email = session?.user?.email as string;
    const img = session?.user?.image as string;
    return (
        <div className="flex md:order-2">
            <Dropdown
                arrowIcon={false}
                inline
                label={<Avatar alt={name} img={img} rounded />}
            >
                <Dropdown.Header>
                    <span className="block text-sm">{name}</span>
                    <span className="block truncate text-sm font-medium">
                        {email}
                    </span>
                </Dropdown.Header>
                <Dropdown.Item onClick={() => signOut()}>Logout</Dropdown.Item>
            </Dropdown>
            <Navbar.Toggle />
        </div>
    );
};

export default SignedDropdown;
