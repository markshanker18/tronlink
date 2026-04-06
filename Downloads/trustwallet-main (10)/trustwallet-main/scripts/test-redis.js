
import Redis from 'ioredis';
import dotenv from 'dotenv';
import path from 'path';

// Load .env
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const url = process.env.REDIS_URL;

async function testRedis() {
    console.log(`Testing Redis connection to: ${url}...`);
    const redis = new Redis(url);
    try {
        await redis.ping();
        console.log(`SUCCESS: Connected to Redis!`);
        await redis.quit();
    } catch (err) {
        console.error(`FAILURE: Error with Redis:`, err.message);
    }
}

testRedis();
