import { createOpenLibraryClient } from "./open-library"

const client = createOpenLibraryClient()

export const searchBookByISBN = client.searchBookByISBN
