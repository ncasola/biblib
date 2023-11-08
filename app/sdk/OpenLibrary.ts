import type { AxiosInstance } from "axios";
import axios from "axios";

import { IsbnSchema } from "@/app/schemas/Isbn.schema";

class OpenLibrary {
    client: AxiosInstance;
    constructor() {
        this.client = axios.create({
            baseURL: "https://openlibrary.org",
        });
    }
    async searchBookByISBN(isbn: string) {
        const { data } = await this.client.get(`/api/books`, {
            params: {
                bibkeys: `ISBN:${isbn}`,
                format: "json",
                jscmd: "data",
            },
        });
        if (!data[`ISBN:${isbn}`]) {
            return null;
        } else {
            const parsedData = IsbnSchema.safeParse(data[`ISBN:${isbn}`]);
            if (!parsedData.success) {
                return null;
            }
            return parsedData.data;
        }
    }
}

export default OpenLibrary;
