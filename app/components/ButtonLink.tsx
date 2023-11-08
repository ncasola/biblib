"use client";

import { Button } from "flowbite-react";
import Link from "next/link";
import { HiOutlineArrowRight } from "react-icons/hi";

type Props = {
    title: string;
    href: string;
};

const ButtonLink = (props: Props) => {
    return (
        <Link href={props.href}>
            <Button>
                {props.title} <HiOutlineArrowRight className="ml-2 h-5 w-5" />
            </Button>
        </Link>
    );
};

export default ButtonLink;
