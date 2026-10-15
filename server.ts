import { app } from "./app";
import { env } from "./config/env";
import { prisma } from "./config/prisma";
import { inboundQueue, reminderQueue } from "./config/queue";

const server = app.listen(env.PORT, () => console.log(`HisabBani API listening on port ${env.PORT}`));
async function shutdown(): Promise<void> {
  server.close(async () => {
    await Promise.all([inboundQueue.close(), reminderQueue.close(), prisma.$disconnect()]);
    process.exit(0);
  });
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());