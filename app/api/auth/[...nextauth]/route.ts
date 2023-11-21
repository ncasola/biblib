import type { AuthOptions } from "next-auth";
import NextAuth from "next-auth";
import GitHubProvider from "next-auth/providers/github";

import config from "@/app/config";

export const authOptions: AuthOptions = {
    providers: [
        GitHubProvider({
            clientId: config.GITHUB_ID,
            clientSecret: config.GITHUB_SECRET,
        }),
    ],
    pages: {
        signIn: "/login",
    },
};

const handler = NextAuth(authOptions);

export { handler as GET, handler as POST };
