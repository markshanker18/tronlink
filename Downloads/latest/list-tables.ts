import { db } from "./server/db";
import { sql } from "drizzle-orm";
import "dotenv/config";

(async () => {
    try {
        const res = await db.execute(sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`);
        console.log("Tables:", res.rows.map(r => r.table_name));
        process.exit(0);
    } catch (err) {
        console.error("Error:", err.message);
        process.exit(1);
    }
})();
