import { loadConfig } from "@edgelab/config";
import { buildApp } from "./app.js";

const config = loadConfig();
const app = buildApp(config);

await app.listen({ host: "0.0.0.0", port: config.PORT });
