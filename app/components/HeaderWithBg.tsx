"use client";

import React from "react";

type Props = {
    children: React.ReactNode;
};

const HeaderWithBg = (props: Props) => {
    return (
        <div className="flex flex-col md:flex-row justify-center md:justify-start items-center gap-4 rounded-lg shadow-md dark:bg-gray-800 bg-gray-100 p-4 md:max-w-max ">
            {props.children}
        </div>
    );
};

export default HeaderWithBg;
