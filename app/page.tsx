import { SignedIn, SignedOut, SignIn } from "@clerk/nextjs";

import HeaderWithBg from "@/app/components/HeaderWithBg";
import Heading from "@/app/components/Heading";

import ButtonLink from "./components/ButtonLink";

export default async function Home() {
    return (
        <>
            <SignedIn>
                <div className="flex flex-col items-center justify-center">
                    <HeaderWithBg>
                        <Heading title="Welcome" subtitle="to BibLib" />
                    </HeaderWithBg>
                    <hr className="w-48 h-1 mx-auto my-4 bg-slate-800 border-0 rounded md:my-10" />
                    <ButtonLink title="Go to dashboard" href="/dashboard" />
                </div>
            </SignedIn>
            <SignedOut>
                <div className="flex flex-col items-center justify-center">
                    <HeaderWithBg>
                        <Heading title="Login" subtitle="in BibLib" />
                    </HeaderWithBg>
                    <hr className="w-48 h-1 mx-auto my-4 bg-slate-800 border-0 rounded md:my-10" />
                    <SignIn redirectUrl="/dashboard" />
                </div>
            </SignedOut>
        </>
    );
}
