(async () => {
    const url = "https://cryptopay-app-live.vercel.app/api/auth/login";
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username: "testuser", password: "password" })
        });
        console.log("Status:", res.status);
        const text = await res.text();
        console.log("Body:", text);
    } catch (err: any) {
        console.error("Error:", err.message);
    }
})();
