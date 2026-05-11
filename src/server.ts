import { app } from "./app.js";
import { env } from "./config/env.js";

const port = env.PORT;

app.listen(port, () => {
  console.log(`[forja-api] listening on :${port} (${env.NODE_ENV})`);
});
