const sqlite3 = require("sqlite3").verbose();
const mysql = require("mysql2/promise");
const path = require("path");

const SQLITE_PATH = path.join(__dirname, "data", "events.db");

const MYSQL_CONFIG = {
  host: "127.0.0.1",
  user: "root",
  password: "",            // Laragon sering kosong
  database: "pest_dashboard",
};

(async () => {
  const sdb = new sqlite3.Database(SQLITE_PATH);
  const mdb = await mysql.createConnection(MYSQL_CONFIG);

  const tables = await new Promise((resolve, reject) => {
    sdb.all(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;",
      (err, rows) => (err ? reject(err) : resolve(rows.map(r => r.name)))
    );
  });

  // Pastikan target kosong (biar rerun aman & tidak dobel)
  await mdb.query("SET FOREIGN_KEY_CHECKS=0;");
  for (const t of tables) await mdb.query(`TRUNCATE TABLE \`${t}\`;`);

  for (const table of tables) {
    const rows = await new Promise((resolve, reject) => {
      sdb.all(`SELECT * FROM ${table};`, (err, rs) => (err ? reject(err) : resolve(rs)));
    });

    if (rows.length === 0) {
      console.log(`[${table}] empty`);
      continue;
    }

    const cols = Object.keys(rows[0]);
    const colList = cols.map(c => `\`${c}\``).join(",");
    const placeholders = cols.map(() => "?").join(",");

    const batchSize = 500;
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      const values = [];
      const multi = batch
        .map(r => {
          cols.forEach(c => values.push(r[c]));
          return `(${placeholders})`;
        })
        .join(",");

      await mdb.query(
        `INSERT INTO \`${table}\` (${colList}) VALUES ${multi};`,
        values
      );
    }

    console.log(`[${table}] imported: ${rows.length} rows`);
  }

  // rapihin AUTO_INCREMENT supaya lanjut insert normal
  for (const table of tables) {
    const [[r]] = await mdb.query(`SELECT MAX(id) AS maxId FROM \`${table}\`;`);
    const nextId = (r.maxId || 0) + 1;
    await mdb.query(`ALTER TABLE \`${table}\` AUTO_INCREMENT = ${nextId};`);
  }

  await mdb.query("SET FOREIGN_KEY_CHECKS=1;");
  await mdb.end();
  sdb.close();
  console.log("DONE.");
})();