import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./shared/schema";
import "dotenv/config";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
    process.exit(1);
}

const pool = new pg.Pool({
    connectionString: databaseUrl,
});

(async () => {
    try {
        const client = await pool.connect();
        console.log("Connected successfully");
        const res = await client.query("SELECT current_database();");
        console.log("Database:", res.rows[0].current_database);
        client.release();
        process.exit(0);
    } catch (err) {
        console.error("Connection failed:", err.message);
        process.exit(1);
    }
})();
