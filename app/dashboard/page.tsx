import { CardInfo } from "@/app/components/layout/CardInfo";
import HeaderWithBg from "@/app/components/layout/HeaderWithBg";
import Heading from "@/app/components/layout/Heading";
import { connectToDb } from "@/app/config/connectToDb";
import { PersonalBook, Shelf } from "@/app/models";
import { auth } from "@/auth";

export default async function Page() {
    const session = await auth();
    const user = session?.user;
    const email = user?.email as string;
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
