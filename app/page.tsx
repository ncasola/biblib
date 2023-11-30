import ButtonLink from "@/app/components/layout/ButtonLink";
import HeaderWithBg from "@/app/components/layout/HeaderWithBg";
import Heading from "@/app/components/layout/Heading";
import { auth } from "@/auth";

export default async function Home() {
    const session = await auth();
    return (
        <>
            {session && (
                <div className="flex flex-col items-center justify-center">
                    <HeaderWithBg>
                        <Heading title="Welcome" subtitle="to BibLib" />
                    </HeaderWithBg>
                    <hr className="w-48 h-1 mx-auto my-4 bg-slate-800 border-0 rounded md:my-10" />
                    <ButtonLink title="Go to dashboard" href="/dashboard" />
                </div>
            )}
            {!session && (
                <div className="flex flex-col items-center justify-center">
                    <HeaderWithBg>
                        <Heading title="Login" subtitle="in BibLib" />
                    </HeaderWithBg>
                    <hr className="w-48 h-1 mx-auto my-4 bg-slate-800 border-0 rounded md:my-10" />
                    <ButtonLink title="Login" href="/api/auth/signin" />
                </div>
            )}
        </>
    );
}
