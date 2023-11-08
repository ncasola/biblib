import { create } from "zustand";

interface PrvBook {
    book: string;
    replaceBook: (book: string) => void;
}

export const usePrvBookStore = create<PrvBook>()((set) => ({
    book: "",
    replaceBook: (book) => set(() => ({ book })),
}));
