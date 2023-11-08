import { getServerSession } from "next-auth";

import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import Heading from "@/app/components/Heading";
import { connectToDb } from "@/app/config/connectToDb";

import { CardInfo } from "../components/CardInfo";
import { PersonalBook } from "../models";

export default async function Page() {
    const session = await getServerSession(authOptions);
    const email = session?.user?.email;
    const fetchBooks = async (email: string) => {
        "use server";
        await connectToDb();
        const count = await PersonalBook.countDocuments({ user: email });
        return count;
    };
    const count = await fetchBooks(email as string);
    return (
        <>
            <div className="flex flex-row justify-start gap-4">
                <Heading title="Dashboard" subtitle="Books" />
            </div>
            <p>You have {count} books in your collection</p>
            <hr className="w-48 h-1 mx-auto my-4 bg-gray-100 border-0 rounded md:my-10 dark:bg-gray-700"></hr>
            <div className="grid grid-cols-2">
                <div>
                    <CardInfo title="Books" href="/dashboard/books" />
                </div>
                <div>
                    <CardInfo title="Shelves" href="/dashboard/shelves" />
                </div>
            </div>
        </>
    );
}
