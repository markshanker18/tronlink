import pg from "pg";
import "dotenv/config";

(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    const pool = new pg.Pool({ connectionString: databaseUrl });
    const client = await pool.connect();
    try {
        console.log("Creating session table...");
        await client.query(`
            CREATE TABLE IF NOT EXISTS "session" (
              "sid" varchar NOT NULL COLLATE "default",
              "sess" json NOT NULL,
              "expire" timestamp(6) NOT NULL
            ) WITH (OIDS=FALSE);
            ALTER TABLE "session" ADD CONSTRAINT "session_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE;
            CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
        `);
        console.log("Session table ensured.");
    } catch (err: any) {
        console.error("Error creating session table:", err.message);
    } finally {
        client.release();
        process.exit(0);
    }
})();
