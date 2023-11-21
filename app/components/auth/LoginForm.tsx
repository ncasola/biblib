"use client";
import { Button } from "flowbite-react";
import type { ClientSafeProvider } from "next-auth/react";
import { signIn } from "next-auth/react";
import { HiUser } from "react-icons/hi";

type LoginFormProps = {
    provider: ClientSafeProvider;
};

const LoginForm = ({ provider }: LoginFormProps) => {
    return (
        <section>
            <div className="flex flex-col items-center px-6 py-8 mx-auto md:h-screen lg:py-0">
                <div className="w-full bg-white rounded-lg shadow dark:border md:mt-0 sm:max-w-md xl:p-0 dark:bg-gray-800 dark:border-gray-700">
                    <div className="p-6 space-y-4 md:space-y-6 sm:p-8">
                        <h1 className="text-center text-xl font-bold leading-tight tracking-tight text-gray-900 md:text-2xl dark:text-white">
                            Sign in to your account
                        </h1>
                        <form className="space-y-4 md:space-y-6" action="#">
                            {provider.name === "GitHub" && (
                                <Button
                                    className="w-full"
                                    color="dark"
                                    onClick={() => signIn(provider.id)}
                                >
                                    <HiUser className="inline-block mr-2" />{" "}
                                    Sign in with GitHub
                                </Button>
                            )}
                        </form>
                    </div>
                </div>
            </div>
        </section>
    );
};

export default LoginForm;
