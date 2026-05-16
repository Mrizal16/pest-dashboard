const pool = require("./db");

(async () => {
  const [rows] = await pool.query("SELECT COUNT(*) AS n FROM events");
  console.log("events rows:", rows[0].n);
  process.exit(0);
})();