import { getServerSession } from "next-auth";

import { authOptions } from "@/app/auth/[...nextauth]/route";
import { CardInfo } from "@/app/components/CardInfo";
import HeaderWithBg from "@/app/components/HeaderWithBg";
import Heading from "@/app/components/Heading";
import { connectToDb } from "@/app/config/connectToDb";
import { PersonalBook, Shelf } from "@/app/models";

export default async function Page() {
    const session = await getServerSession(authOptions);
    const email = session?.user?.email;
    const fetchData = async (email: string) => {
        "use server";
        await connectToDb();
        const countBooks = await PersonalBook.countDocuments({ user: email });
        const countShelves = await Shelf.countDocuments({ user: email });
        return {
            countBooks,
            countShelves,
        };
    };
    const { countBooks, countShelves } = await fetchData(email as string);
    return (
        <>
            <div className="grid grid-cols-1 place-items-center">
                <HeaderWithBg>
                    <Heading title="Dashboard" subtitle="Books" />
                </HeaderWithBg>
            </div>
            <div className="shelf">
                <CardInfo
                    title="Books"
                    href="/dashboard/books"
                    image="/books.png"
                    description={`${countBooks} books`}
                />
                <CardInfo
                    title="Shelves"
                    href="/dashboard/shelves"
                    image="/shelves.png"
                    description={`${countShelves} shelves`}
                />
            </div>
        </>
    );
}
