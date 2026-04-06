
import pg from 'pg';

async function testLocal() {
    const urls = [
        "postgresql://postgres:postgres@localhost:5432/postgres",
        "postgresql://postgres@localhost:5432/postgres",
    ];
    
    for (const url of urls) {
        console.log(`Testing local connection: ${url}...`);
        const pool = new pg.Pool({ connectionString: url });
        try {
            const client = await pool.connect();
            console.log(`SUCCESS: Connected to local postgres at ${url}`);
            client.release();
            await pool.end();
            return;
        } catch (err) {
            console.error(`FAILURE: Error with ${url}:`, err.message);
        } finally {
            await pool.end();
        }
    }
}

testLocal();
