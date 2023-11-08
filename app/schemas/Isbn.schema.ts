import * as z from "zod";

export const PublishSchema = z.object({
    name: z.string(),
});
export type Publish = z.infer<typeof PublishSchema>;

export const IdentifiersSchema = z.object({
    librarything: z.array(z.string()).optional(),
    wikidata: z.array(z.string()).optional(),
    goodreads: z.array(z.string()).optional(),
    isbn_10: z.array(z.string()).optional(),
    lccn: z.array(z.string()).optional(),
    openlibrary: z.array(z.string()),
});
export type Identifiers = z.infer<typeof IdentifiersSchema>;

export const EpubSchema = z.object({
    url: z.string().optional(),
});
export type Epub = z.infer<typeof EpubSchema>;

export const FormatsSchema = z.object({
    pdf: EpubSchema.optional(),
    epub: EpubSchema.optional(),
    text: EpubSchema.optional(),
});
export type Formats = z.infer<typeof FormatsSchema>;

export const EbookSchema = z.object({
    preview_url: z.string().optional(),
    availability: z.string().optional(),
    formats: FormatsSchema.optional(),
    read_url: z.string().optional(),
});
export type Ebook = z.infer<typeof EbookSchema>;

export const CoverSchema = z.object({
    small: z.string(),
    medium: z.string(),
    large: z.string(),
});
export type Cover = z.infer<typeof CoverSchema>;

export const ClassificationsSchema = z.object({
    lc_classifications: z.array(z.string()).optional(),
    dewey_decimal_class: z.array(z.string()).optional(),
});
export type Classifications = z.infer<typeof ClassificationsSchema>;

export const AuthorSchema = z.object({
    url: z.string(),
    name: z.string(),
});
export type Author = z.infer<typeof AuthorSchema>;

export const IsbnSchema = z.object({
    url: z.string(),
    key: z.string(),
    title: z.string(),
    subtitle: z.string().optional(),
    authors: z.array(AuthorSchema),
    number_of_pages: z.number(),
    pagination: z.string().optional(),
    by_statement: z.string().optional(),
    identifiers: IdentifiersSchema,
    classifications: ClassificationsSchema.optional(),
    publishers: z.array(PublishSchema).optional(),
    publish_places: z.array(PublishSchema).optional(),
    publish_date: z.string(),
    subjects: z.array(AuthorSchema).optional(),
    notes: z.string().optional(),
    ebooks: z.array(EbookSchema).optional(),
    cover: CoverSchema,
});
export type Isbn = z.infer<typeof IsbnSchema>;
