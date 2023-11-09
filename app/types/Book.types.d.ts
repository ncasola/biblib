export interface IBookInputDTO {
    isbn: string;
}

export interface PersonalBookDTO {
    isbn: string;
    user: string;
    status: string;
    shelf: string;
}

export interface BookItem {
    id: string;
    title: string;
    publishDate: string;
    image: string;
    shelf: string;
}
