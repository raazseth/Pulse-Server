import { Pool } from "pg";
import { logger } from "@/internal/pkg/logger";

export class PostgresInfra {
  readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
    this.pool.on("connect", () => logger.info("DB     ▸ client connected to pool"));
    this.pool.on("error", (err) => logger.error("DB     ▸ idle client error", err));
  }

  async ping(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("SELECT 1");
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
    logger.info("DB     ▸ pool closed");
  }
}
