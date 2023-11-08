export const extractCover = (cover: {
    small: string;
    medium: string;
    large: string;
}) => {
    const keys = Object.keys(cover);
    const image = {
        url: "",
    };
    keys.forEach((key) => {
        const url = cover[key as keyof typeof cover];
        if (url) {
            image.url = url;
        } else {
            image.url = "/images/cover-placeholder.png";
        }
    });
    return image.url;
};
