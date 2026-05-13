import { app } from "./app.js";
import { env } from "./config/env.js";
import { registerCronJobs } from "./cron/index.js";
import { pingGemini } from "./services/gemini.service.js";

const port = env.PORT;

app.listen(port, () => {
  console.log(`[forja-api] listening on :${port} (${env.NODE_ENV})`);
  registerCronJobs();
  void pingGemini();
});
