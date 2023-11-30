"use client";

type Props = {
    title: string;
    subtitle: string;
};

function Heading({ title, subtitle }: Props) {
    return (
        <h1 className="mb-4 text-6xl font-extrabold text-gray-900 dark:text-white">
            <span className="text-transparent bg-clip-text bg-gradient-to-r to-emerald-600 from-sky-400">
                {title}
            </span>{" "}
            {subtitle}
        </h1>
    );
}

export default Heading;
