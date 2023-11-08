"use client";

type Props = {
    title: string;
};

const Header = (props: Props) => {
    return (
        <header className="">
            <h1 className="text-4xl font-bold">{props.title}</h1>
        </header>
    );
};

export default Header;
