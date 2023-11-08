import type { Config } from "tailwindcss";

const config: Config = {
    content: [
        "./components/**/*.{js,ts,jsx,tsx,mdx}",
        "./app/**/*.{js,ts,jsx,tsx,mdx}",
        "./node_modules/flowbite-react/**/*.js",
    ],
    theme: {},
    plugins: [require("flowbite/plugin")],
};
export default config;
