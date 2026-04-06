
import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';

// Load .env
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const originalUrl = process.env.DATABASE_URL;

async function test(url, label) {
    console.log(`Testing ${label}...`);
    const pool = new pg.Pool({
        connectionString: url,
    });
    try {
        const client = await pool.connect();
        console.log(`SUCCESS: Connected with ${label}`);
        client.release();
        return true;
    } catch (err) {
        console.error(`FAILURE: Error with ${label}:`, err.message);
        return false;
    } finally {
        await pool.end();
    }
}

async function run() {
    await test(originalUrl, "original URL");
    const noChannelBinding = originalUrl.replace("&channel_binding=require", "").replace("?channel_binding=require", "");
    await test(noChannelBinding, "URL without channel_binding");
}

run();
