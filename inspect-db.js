const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const dbPath = path.join(__dirname, "data", "events.db");
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  db.all(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;",
    (err, tables) => {
      if (err) throw err;
      console.log("Tables:", tables.map(t => t.name));

      const next = (i = 0) => {
        if (i >= tables.length) return db.close();
        const table = tables[i].name;

        db.all(`PRAGMA table_info(${table});`, (e, cols) => {
          console.log(`\n== ${table} columns ==`);
          console.table(cols);

          db.all(`SELECT * FROM ${table} LIMIT 5;`, (e2, rows) => {
            console.log(`Sample rows (${table}):`, rows);
            next(i + 1);
          });
        });
      };
      next();
    }
  );
});