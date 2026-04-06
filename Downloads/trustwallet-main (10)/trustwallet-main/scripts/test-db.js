
import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';

// Load .env from the root directory
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
    console.error("DATABASE_URL not found in .env");
    process.exit(1);
}

const pool = new pg.Pool({
    connectionString: databaseUrl,
});

async function testConnection() {
    try {
        const client = await pool.connect();
        console.log("Successfully connected to the database.");
        const res = await client.query('SELECT NOW()');
        console.log("Database time:", res.rows[0].now);
        client.release();
    } catch (err) {
        console.error("Error connecting to the database:", err.message);
    } finally {
        await pool.end();
    }
}

testConnection();
