
import pg from 'pg';

async function testWorking() {
    const url = "postgresql://neondb_owner:npg_cOqmHE0Mbk4n@ep-misty-cloud-amkbgqy2-pooler.c-5.us-east-1.aws.neon.tech/neondb?sslmode=require";
    console.log(`Testing likely working URL: ${url}...`);
    const pool = new pg.Pool({ connectionString: url });
    try {
        const client = await pool.connect();
        console.log(`SUCCESS: Connected!`);
        const res = await client.query('SELECT NOW()');
        console.log("Database time:", res.rows[0].now);
        client.release();
        await pool.end();
        return;
    } catch (err) {
        console.error(`FAILURE: Error with URL:`, err.message);
    } finally {
        await pool.end();
    }
}

testWorking();
