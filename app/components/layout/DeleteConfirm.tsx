"use client";

import { Button, Modal } from "flowbite-react";
import { HiOutlineExclamationCircle } from "react-icons/hi";

type Props = {
    open: boolean;
    setResult: (result: boolean) => void;
    setOpen: (openModal: boolean) => void;
};

export function DeleteConfirm(props: Props) {
    const { setResult, setOpen, open } = props;
    const handlerConfirm = () => {
        setResult(true);
        setOpen(false);
    };

    return (
        <>
            <Modal show={open} size="md" onClose={() => setOpen(false)} popup>
                <Modal.Header />
                <Modal.Body>
                    <div className="text-center">
                        <HiOutlineExclamationCircle className="mx-auto mb-4 h-14 w-14 text-gray-400 dark:text-gray-200" />
                        <h3 className="mb-5 text-lg font-normal text-gray-500 dark:text-gray-400">
                            Are you sure you want to delete this book?
                        </h3>
                        <div className="flex justify-center gap-4">
                            <Button
                                color="failure"
                                onClick={() => handlerConfirm()}
                            >
                                {"Yes, I'm sure"}
                            </Button>
                            <Button color="gray" onClick={() => setOpen(false)}>
                                No, cancel
                            </Button>
                        </div>
                    </div>
                </Modal.Body>
            </Modal>
        </>
    );
}
