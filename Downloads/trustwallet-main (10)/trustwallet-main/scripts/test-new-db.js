
import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';

// Load .env
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const url = process.env.DATABASE_URL;

async function testConnection() {
    console.log(`Testing connection to: ${url}...`);
    const pool = new pg.Pool({ connectionString: url });
    try {
        const client = await pool.connect();
        console.log(`SUCCESS: Connected!`);
        const res = await client.query('SELECT NOW()');
        console.log("Database time:", res.rows[0].now);
        client.release();
    } catch (err) {
        console.error(`FAILURE: Error with URL:`, err.message);
    } finally {
        await pool.end();
    }
}

testConnection();
