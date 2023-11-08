import zod from "zod";

const schema = zod.object({
    PORT: zod.string().default("3000"),
    NODE_ENV: zod
        .enum(["development", "production", "test"])
        .default("development"),
    MONGO_URL: zod.string().default("mongodb://localhost:27017/biblib"),
    GITHUB_ID: zod.string().default(""),
    GITHUB_SECRET: zod.string().default(""),
});

const config = schema.parse(process.env);

export default config;
