import { connect, ConnectOptions } from "mongoose";

import config from "./index";

async function connectToDb() {
    connect(config.MONGO_URL, {
        useNewUrlParser: true,
        useUnifiedTopology: true,
    } as ConnectOptions).then(() => {
        console.log("Connected to MongoDB");
    });
}

export { connectToDb };
