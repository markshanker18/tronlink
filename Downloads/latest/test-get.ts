(async () => {
    const url = "https://cryptopay-app-live.vercel.app/api/local-ip";
    try {
        const res = await fetch(url);
        console.log("Status:", res.status);
        const data = await res.json();
        console.log("Data:", data);
    } catch (err: any) {
        console.error("Error:", err.message);
    }
})();
