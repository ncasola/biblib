import { create } from "zustand";

export interface Toast {
    message: string;
    color: string;
    setToast: (message: string, color: string) => void;
    clearToast: () => void;
}

export const useToastStore = create<Toast>((set) => ({
    message: "",
    color: "",
    setToast: (message: string, color: string) => set({ message, color }),
    clearToast: () => set({ message: "", color: "" }),
}));
