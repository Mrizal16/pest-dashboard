const express = require("express");
const mqtt = require("mqtt");
const path = require("path");

// pakai pool yang sudah kamu buat di db.js
const pool = require("./db");

// ============ CONFIG ============
const HTTP_PORT = 8080;

// MQTT
const MQTT_URL = "mqtt://broker.hivemq.com:1883";
const TOPIC_TELEMETRY = "pearlyyca/rizal/esp32-01/telemetry";
const TOPIC_CONFIG = "pearlyyca/rizal/esp32-01/config";

// WIB grouping
const TZ_OFFSET_HOURS = 7;
const TZ_OFFSET_SEC = TZ_OFFSET_HOURS * 3600;

// default (DFD)
const DEFAULT_DAYS = 7;
const DEFAULT_MONTHS = 6;
const DEFAULT_LATEST = 50;

// WhatsApp notification summary
// Nomor WA Indonesia: 083854352773 -> 6283854352773
const WA_ENABLED = true;
const WA_TARGET = "6283854352773";
const WA_API_TOKEN = "Xuo8Wz1f473NvxDji8ry";
const WA_API_URL = "https://api.fonnte.com/send";

// Cek tiap 1 menit.
// Tapi WA hanya dikirim untuk periode 1 jam yang sudah selesai.
const WA_CHECK_INTERVAL_MS = 60 * 1000;

// ============ INIT APP ============
const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// Pastikan FROM_UNIXTIME() dihitung di UTC (biar +7 jam selalu konsisten)
pool.on?.("connection", (conn) => {
  try {
    conn.query("SET time_zone = '+00:00'");
  } catch (_) {}
});

// helpers mysql
async function dbAll(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

async function dbRun(sql, params = []) {
  const [result] = await pool.execute(sql, params);
  return result;
}

// ============ INIT SCHEMA (AMAN: kalau sudah ada, tidak mengubah) ============
async function initMySqlSchema() {
  await dbRun(`
    CREATE TABLE IF NOT EXISTS \`events\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`ts\` INT UNSIGNED NULL,
      \`time\` VARCHAR(8) NULL,
      \`mode\` VARCHAR(16) NULL,
      \`sensor\` VARCHAR(16) NULL,
      \`zone\` TINYINT UNSIGNED NULL,
      \`message\` VARCHAR(64) NULL,
      \`actuator\` VARCHAR(64) NULL,
      \`cooldown_ms\` INT UNSIGNED NULL,
      \`rssi\` SMALLINT NULL,
      \`raw_json\` LONGTEXT NULL,
      PRIMARY KEY (\`id\`),
      KEY \`idx_events_ts\` (\`ts\`),
      KEY \`idx_events_zone_ts\` (\`zone\`, \`ts\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS \`config\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`updated_ts\` INT UNSIGNED NULL,
      \`json_text\` LONGTEXT NULL,
      PRIMARY KEY (\`id\`),
      KEY \`idx_config_updated_ts\` (\`updated_ts\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // Tabel ini untuk mencegah laporan WA terkirim dua kali pada periode jam yang sama
  await dbRun(`
    CREATE TABLE IF NOT EXISTS \`wa_notifications\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`period_start_utc\` INT UNSIGNED NOT NULL,
      \`period_end_utc\` INT UNSIGNED NOT NULL,
      \`sent_ts\` INT UNSIGNED NOT NULL,
      \`target\` VARCHAR(32) NOT NULL,
      \`total_events\` INT UNSIGNED NOT NULL DEFAULT 0,
      \`message_text\` TEXT NULL,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uniq_period_target\` (\`period_start_utc\`, \`target\`),
      KEY \`idx_wa_notifications_sent_ts\` (\`sent_ts\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

// ============ DEFAULT CONFIG (yang dipakai kalau DB kosong) ============
const DEFAULT_CONFIG = {
  day_start_hour: 6,
  day_end_hour: 18,
  warmup_ms: 30000,
  debounce_ms: 200,
  cooldown_min_ms: 10000,
  cooldown_max_ms: 20000,

  servo_idle: 0,

  // SIANG
  servo_day_min: 30,
  servo_day_max: 120,
  day_move_count_min: 3,
  day_move_count_max: 7,
  day_step_delay_min_ms: 150,
  day_step_delay_max_ms: 600,

  // MALAM (servo)
  servo_night_min: 60,
  servo_night_max: 130,
  night_move_count_min: 3,
  night_move_count_max: 6,
  night_step_delay_min_ms: 120,
  night_step_delay_max_ms: 450,

  // MALAM (buzzer)
  buzzer_on_min_ms: 400,
  buzzer_on_max_ms: 800,
  buzzer_off_min_ms: 1000,
  buzzer_off_max_ms: 2000,

  // PIR 4 zona (enable/disable)
  pir_enabled: [true, true, true, true],
};

let currentConfig = { ...DEFAULT_CONFIG };
let configLoaded = false;

// ============ SSE realtime ============
const sseClients = new Set();

app.get("/api/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`);
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});

function broadcastSSE(eventObj) {
  const msg = `event: new_event\ndata: ${JSON.stringify(eventObj)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(msg);
    } catch (_) {
      sseClients.delete(client);
    }
  }
}

// ============ MQTT ============
const mqttClient = mqtt.connect(MQTT_URL, { reconnectPeriod: 2000 });

mqttClient.on("connect", async () => {
  console.log("MQTT connected:", MQTT_URL);

  mqttClient.subscribe(TOPIC_TELEMETRY, (err) => {
    if (err) console.error("Subscribe telemetry error:", err);
    else console.log("Subscribed telemetry:", TOPIC_TELEMETRY);
  });

  if (configLoaded) publishConfig(currentConfig);
});

mqttClient.on("reconnect", () => console.log("MQTT reconnecting..."));
mqttClient.on("error", (e) => console.error("MQTT error:", e.message));

mqttClient.on("message", async (topic, message) => {
  if (topic !== TOPIC_TELEMETRY) return;

  const payloadStr = message.toString();
  let p;
  try {
    p = JSON.parse(payloadStr);
  } catch {
    return;
  }

  let ts = Number(p.ts);
  if (!Number.isFinite(ts)) return;

  // device kirim ts dari RTC WIB tapi dianggap UTC oleh unixtime()
  // jadi kita geser balik 7 jam supaya ts di DB = UTC
  ts -= TZ_OFFSET_SEC;

  const row = {
    ts,
    time: String(p.time ?? ""),
    mode: String(p.mode ?? ""),
    sensor: String(p.sensor ?? ""),
    zone: Number(p.zone ?? 0),
    message: String(p.message ?? ""),
    actuator: String(p.actuator ?? ""),
    cooldown_ms: Number(p.cooldown_ms ?? 0),
    rssi: Number(p.rssi ?? -999),
    raw_json: payloadStr,
  };

  try {
    await dbRun(
      `INSERT INTO \`events\`
        (\`ts\`, \`time\`, \`mode\`, \`sensor\`, \`zone\`, \`message\`, \`actuator\`, \`cooldown_ms\`, \`rssi\`, \`raw_json\`)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.ts,
        row.time,
        row.mode,
        row.sensor,
        row.zone,
        row.message,
        row.actuator,
        row.cooldown_ms,
        row.rssi,
        row.raw_json,
      ]
    );

    broadcastSSE(row);
  } catch (err) {
    console.error("DB insert error:", err.message);
  }
});

function publishConfig(cfg) {
  if (!mqttClient.connected) return;
  const payload = JSON.stringify(cfg);
  mqttClient.publish(TOPIC_CONFIG, payload, { qos: 1, retain: true }, (err) => {
    if (err) console.error("Publish config error:", err);
    else console.log("Published config (retained) to:", TOPIC_CONFIG);
  });
}

// ============ HELPERS CONFIG ============
function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

function clampMs(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

function applyLegacyConfigShape(obj, cfg) {
  const out = { ...cfg, ...obj };

  const oldNightAngle = Number(obj?.servo_night_angle);
  if (Number.isFinite(oldNightAngle)) {
    const angle = Math.min(Math.max(Math.trunc(oldNightAngle), 0), 180);
    if (obj?.servo_night_min == null) out.servo_night_min = angle;
    if (obj?.servo_night_max == null) out.servo_night_max = angle;
  }

  delete out.servo_night_angle;
  return out;
}

// ============ LOAD CONFIG FROM DB ON START ============
async function loadConfigFromDb() {
  const rows = await dbAll(
    `SELECT \`json_text\` FROM \`config\` ORDER BY \`updated_ts\` DESC, \`id\` DESC LIMIT 1`
  );

  if (rows.length === 0) {
    await dbRun(`INSERT INTO \`config\` (\`updated_ts\`, \`json_text\`) VALUES (?, ?)`, [
      Math.floor(Date.now() / 1000),
      JSON.stringify(DEFAULT_CONFIG),
    ]);
    currentConfig = { ...DEFAULT_CONFIG };
    return;
  }

  try {
    const obj = JSON.parse(rows[0].json_text);
    currentConfig = applyLegacyConfigShape(obj, { ...DEFAULT_CONFIG });
  } catch {
    currentConfig = { ...DEFAULT_CONFIG };
  }
}

// ============ API: CONFIG (D2) ============
function normalizeConfig(input) {
  const cfg = { ...currentConfig };

  cfg.day_start_hour = clampInt(input.day_start_hour, 0, 23, cfg.day_start_hour);
  cfg.day_end_hour = clampInt(input.day_end_hour, 1, 24, cfg.day_end_hour);
  if (cfg.day_end_hour <= cfg.day_start_hour) {
    cfg.day_end_hour = Math.min(cfg.day_start_hour + 1, 24);
  }

  cfg.warmup_ms = clampMs(input.warmup_ms, 0, 300000, cfg.warmup_ms);
  cfg.debounce_ms = clampMs(input.debounce_ms, 0, 2000, cfg.debounce_ms);

  cfg.cooldown_min_ms = clampMs(input.cooldown_min_ms, 0, 600000, cfg.cooldown_min_ms);
  cfg.cooldown_max_ms = clampMs(input.cooldown_max_ms, 0, 600000, cfg.cooldown_max_ms);
  if (cfg.cooldown_max_ms < cfg.cooldown_min_ms) {
    cfg.cooldown_max_ms = cfg.cooldown_min_ms;
  }

  cfg.servo_idle = clampInt(input.servo_idle, 0, 180, cfg.servo_idle);

  cfg.servo_day_min = clampInt(input.servo_day_min, 0, 180, cfg.servo_day_min);
  cfg.servo_day_max = clampInt(input.servo_day_max, 0, 180, cfg.servo_day_max);
  if (cfg.servo_day_max < cfg.servo_day_min) {
    cfg.servo_day_max = cfg.servo_day_min;
  }

  cfg.day_move_count_min = clampInt(input.day_move_count_min, 1, 50, cfg.day_move_count_min);
  cfg.day_move_count_max = clampInt(input.day_move_count_max, 1, 50, cfg.day_move_count_max);
  if (cfg.day_move_count_max < cfg.day_move_count_min) {
    cfg.day_move_count_max = cfg.day_move_count_min;
  }

  cfg.day_step_delay_min_ms = clampMs(input.day_step_delay_min_ms, 10, 10000, cfg.day_step_delay_min_ms);
  cfg.day_step_delay_max_ms = clampMs(input.day_step_delay_max_ms, 10, 10000, cfg.day_step_delay_max_ms);
  if (cfg.day_step_delay_max_ms < cfg.day_step_delay_min_ms) {
    cfg.day_step_delay_max_ms = cfg.day_step_delay_min_ms;
  }

  const legacyNightAngle = Number.isFinite(Number(input.servo_night_angle))
    ? clampInt(input.servo_night_angle, 0, 180, cfg.servo_night_min)
    : null;

  const nightMinFallback = legacyNightAngle ?? cfg.servo_night_min;
  const nightMaxFallback = legacyNightAngle ?? cfg.servo_night_max;

  cfg.servo_night_min = clampInt(input.servo_night_min, 0, 180, nightMinFallback);
  cfg.servo_night_max = clampInt(input.servo_night_max, 0, 180, nightMaxFallback);
  if (cfg.servo_night_max < cfg.servo_night_min) {
    cfg.servo_night_max = cfg.servo_night_min;
  }

  cfg.night_move_count_min = clampInt(input.night_move_count_min, 1, 50, cfg.night_move_count_min);
  cfg.night_move_count_max = clampInt(input.night_move_count_max, 1, 50, cfg.night_move_count_max);
  if (cfg.night_move_count_max < cfg.night_move_count_min) {
    cfg.night_move_count_max = cfg.night_move_count_min;
  }

  cfg.night_step_delay_min_ms = clampMs(input.night_step_delay_min_ms, 10, 10000, cfg.night_step_delay_min_ms);
  cfg.night_step_delay_max_ms = clampMs(input.night_step_delay_max_ms, 10, 10000, cfg.night_step_delay_max_ms);
  if (cfg.night_step_delay_max_ms < cfg.night_step_delay_min_ms) {
    cfg.night_step_delay_max_ms = cfg.night_step_delay_min_ms;
  }

  cfg.buzzer_on_min_ms = clampMs(input.buzzer_on_min_ms, 10, 10000, cfg.buzzer_on_min_ms);
  cfg.buzzer_on_max_ms = clampMs(input.buzzer_on_max_ms, 10, 10000, cfg.buzzer_on_max_ms);
  if (cfg.buzzer_on_max_ms < cfg.buzzer_on_min_ms) {
    cfg.buzzer_on_max_ms = cfg.buzzer_on_min_ms;
  }

  cfg.buzzer_off_min_ms = clampMs(input.buzzer_off_min_ms, 10, 10000, cfg.buzzer_off_min_ms);
  cfg.buzzer_off_max_ms = clampMs(input.buzzer_off_max_ms, 10, 10000, cfg.buzzer_off_max_ms);
  if (cfg.buzzer_off_max_ms < cfg.buzzer_off_min_ms) {
    cfg.buzzer_off_max_ms = cfg.buzzer_off_min_ms;
  }

  if (Array.isArray(input.pir_enabled)) {
    cfg.pir_enabled = [0, 1, 2, 3].map((i) => Boolean(input.pir_enabled[i]));
  }

  delete cfg.servo_night_angle;
  return cfg;
}

app.get("/api/config", (req, res) => {
  res.json({ config: currentConfig, topic: TOPIC_CONFIG });
});

app.post("/api/config", async (req, res) => {
  try {
    const newCfg = normalizeConfig(req.body || {});
    currentConfig = newCfg;

    await dbRun(`INSERT INTO \`config\` (\`updated_ts\`, \`json_text\`) VALUES (?, ?)`, [
      Math.floor(Date.now() / 1000),
      JSON.stringify(newCfg),
    ]);

    publishConfig(newCfg);
    res.json({ ok: true, config: newCfg });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============ WIB helpers (epoch-based, aman) ============
function wibNowEpoch() {
  return Math.floor(Date.now() / 1000) + TZ_OFFSET_SEC;
}

function wibStartOfDayEpoch(wibEpoch) {
  return Math.floor(wibEpoch / 86400) * 86400;
}

function utcFromWibEpoch(wibEpoch) {
  return wibEpoch - TZ_OFFSET_SEC;
}

function fmtDayFromWibEpoch(wibEpoch) {
  return new Date(wibEpoch * 1000).toISOString().slice(0, 10);
}

function fmtMonthFromWibEpoch(wibEpoch) {
  return new Date(wibEpoch * 1000).toISOString().slice(0, 7);
}

function fmtWibDateTimeFromUtcEpoch(utcEpoch) {
  return new Date((utcEpoch + TZ_OFFSET_SEC) * 1000)
    .toISOString()
    .slice(0, 16)
    .replace("T", " ");
}

  async function getRecommendation() {

    const birdRows = await dbAll(`
      SELECT
        HOUR(FROM_UNIXTIME(ts + ?)) AS hour,
        COUNT(*) AS total
      FROM events
      WHERE mode='SIANG'
        AND DATE(FROM_UNIXTIME(ts + ?))
        =
        DATE(DATE_SUB(CONVERT_TZ(NOW(),'+00:00','+07:00'),INTERVAL 1 DAY))
      GROUP BY hour
      ORDER BY hour
    `,[TZ_OFFSET_SEC,TZ_OFFSET_SEC]);

    const ratRows = await dbAll(`
      SELECT
        HOUR(FROM_UNIXTIME(ts + ?)) AS hour,
        COUNT(*) AS total
      FROM events
      WHERE mode='MALAM'
        AND DATE(FROM_UNIXTIME(ts + ?))
        =
        DATE(DATE_SUB(CONVERT_TZ(NOW(),'+00:00','+07:00'),INTERVAL 1 DAY))
      GROUP BY hour
      ORDER BY hour
    `,[TZ_OFFSET_SEC,TZ_OFFSET_SEC]);


    function bestWindow(rows){

        const arr=new Array(24).fill(0);

        rows.forEach(r=>{
            arr[Number(r.hour)] = Number(r.total);
        });

        let best={
            start:0,
            end:2,
            total:0
        };

        for(let i=0;i<22;i++){

            const total=
                arr[i]+
                arr[i+1]+
                arr[i+2];

            if(total>best.total){

                best={
                    start:i,
                    end:i+2,
                    total
                };

            }

        }

        return best;

    }


    return{

        bird:bestWindow(birdRows),

        rat:bestWindow(ratRows)

    };

  }

// ============ WHATSAPP SUMMARY 1 JAM ============
function pickTop(rows, fallback = "-") {
  if (!Array.isArray(rows) || rows.length === 0) return fallback;
  const r = rows[0];
  return `${r.label || fallback} (${Number(r.count) || 0})`;
}

async function sendWhatsAppMessage(text) {
  if (!WA_ENABLED) {
    console.log("WA notification disabled.");
    return false;
  }

  if (!WA_API_TOKEN) {
    console.warn("WA_API_TOKEN belum diisi. Notifikasi WhatsApp tidak dikirim.");
    return false;
  }

  const body = new URLSearchParams({
    target: WA_TARGET,
    message: text,
  });

  const response = await fetch(WA_API_URL, {
    method: "POST",
    headers: {
      Authorization: WA_API_TOKEN,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(`WA API error ${response.status}: ${responseText}`);
  }

  console.log("WA notification sent:", responseText);
  return true;
}

async function runHourlyWhatsAppSummary() {
  try {
    const wibNow = wibNowEpoch();

    // Ambil periode 1 jam yang sudah selesai.
    // Contoh sekarang 10:05 WIB -> kirim laporan 09:00 - 10:00 WIB.
    const wibCurrentHourStart = Math.floor(wibNow / 3600) * 3600;
    const wibPeriodStart = wibCurrentHourStart - 3600;
    const wibPeriodEnd = wibCurrentHourStart;

    const utcPeriodStart = utcFromWibEpoch(wibPeriodStart);
    const utcPeriodEnd = utcFromWibEpoch(wibPeriodEnd);

    const alreadySent = await dbAll(
      `SELECT \`id\`
       FROM \`wa_notifications\`
       WHERE \`period_start_utc\` = ? AND \`target\` = ?
       LIMIT 1`,
      [utcPeriodStart, WA_TARGET]
    );

    if (alreadySent.length > 0) return;

    const totalRows = await dbAll(
      `SELECT COUNT(*) AS total, MAX(\`ts\`) AS last_ts
       FROM \`events\`
       WHERE \`ts\` >= ? AND \`ts\` < ?`,
      [utcPeriodStart, utcPeriodEnd]
    );

    const total = Number(totalRows[0]?.total || 0);
    const lastTs = Number(totalRows[0]?.last_ts || 0);

    // Kalau tidak ada deteksi selama 1 jam, tidak kirim WhatsApp.
    // Tapi tetap dicatat supaya periode itu tidak dicek/dikirim ulang.
    if (total <= 0) {
      await dbRun(
        `INSERT IGNORE INTO \`wa_notifications\`
          (\`period_start_utc\`, \`period_end_utc\`, \`sent_ts\`, \`target\`, \`total_events\`, \`message_text\`)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          utcPeriodStart,
          utcPeriodEnd,
          Math.floor(Date.now() / 1000),
          WA_TARGET,
          0,
          "Tidak ada deteksi, WA tidak dikirim.",
        ]
      );

      console.log(
        `Tidak ada deteksi pada periode ${fmtWibDateTimeFromUtcEpoch(utcPeriodStart)} - ${fmtWibDateTimeFromUtcEpoch(utcPeriodEnd)} WIB`
      );

      return;
    }

    const modeRows = await dbAll(
      `SELECT \`mode\` AS label, COUNT(*) AS count
       FROM \`events\`
       WHERE \`ts\` >= ? AND \`ts\` < ?
       GROUP BY \`mode\`
       ORDER BY count DESC`,
      [utcPeriodStart, utcPeriodEnd]
    );

    const sensorRows = await dbAll(
      `SELECT \`sensor\` AS label, COUNT(*) AS count
       FROM \`events\`
       WHERE \`ts\` >= ? AND \`ts\` < ?
       GROUP BY \`sensor\`
       ORDER BY count DESC`,
      [utcPeriodStart, utcPeriodEnd]
    );

    const actuatorRows = await dbAll(
      `SELECT \`actuator\` AS label, COUNT(*) AS count
       FROM \`events\`
       WHERE \`ts\` >= ? AND \`ts\` < ?
       GROUP BY \`actuator\`
       ORDER BY count DESC`,
      [utcPeriodStart, utcPeriodEnd]
    );

    const zoneRows = await dbAll(
      `SELECT \`zone\` AS label, COUNT(*) AS count
       FROM \`events\`
       WHERE \`ts\` >= ? AND \`ts\` < ?
       GROUP BY \`zone\`
       ORDER BY count DESC, \`zone\` ASC`,
      [utcPeriodStart, utcPeriodEnd]
    );

    const text =
`Laporan Deteksi Gerakan

Periode: ${fmtWibDateTimeFromUtcEpoch(utcPeriodStart)} - ${fmtWibDateTimeFromUtcEpoch(utcPeriodEnd)} WIB
Total deteksi: ${total} kali
Mode dominan: ${pickTop(modeRows)}
Sensor dominan: ${pickTop(sensorRows)}
Zona dominan: ${pickTop(zoneRows)}
Aktuator dominan: ${pickTop(actuatorRows)}
Deteksi terakhir: ${lastTs ? fmtWibDateTimeFromUtcEpoch(lastTs) + " WIB" : "-"}

Pesan ini dikirim otomatis setiap 1 jam jika ada deteksi.`;

    const sent = await sendWhatsAppMessage(text);
    if (!sent) return;

    await dbRun(
      `INSERT IGNORE INTO \`wa_notifications\`
        (\`period_start_utc\`, \`period_end_utc\`, \`sent_ts\`, \`target\`, \`total_events\`, \`message_text\`)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        utcPeriodStart,
        utcPeriodEnd,
        Math.floor(Date.now() / 1000),
        WA_TARGET,
        total,
        text,
      ]
    );
  } catch (err) {
    console.error("Hourly WA summary error:", err.message);
  }
}

// ============ API: DASHBOARD (DFD P2.0) ============
app.get("/api/dashboard", async (req, res) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days ?? DEFAULT_DAYS), 1), 60);
    const months = Math.min(Math.max(Number(req.query.months ?? DEFAULT_MONTHS), 1), 24);
    const latestLimit = Math.min(Math.max(Number(req.query.latest ?? DEFAULT_LATEST), 1), 500);

    const wibNow = wibNowEpoch();
    const wibTodayStart = wibStartOfDayEpoch(wibNow);
    const wibTomorrowStart = wibTodayStart + 86400;

    const utcTodayStart = utcFromWibEpoch(wibTodayStart);
    const utcTomorrowStart = utcFromWibEpoch(wibTomorrowStart);

    const wibWindowDayStart = wibTodayStart - (days - 1) * 86400;
    const utcWindowDayStart = utcFromWibEpoch(wibWindowDayStart);

    const nowWibDate = new Date(wibNow * 1000);
    const y = nowWibDate.getUTCFullYear();
    const m = nowWibDate.getUTCMonth();

    const wibThisMonthStart = Math.floor(Date.UTC(y, m, 1, 0, 0, 0) / 1000);
    const wibNextMonthStart = Math.floor(Date.UTC(y, m + 1, 1, 0, 0, 0) / 1000);
    const wibWindowMonthStart = Math.floor(Date.UTC(y, m - (months - 1), 1, 0, 0, 0) / 1000);

    const utcThisMonthStart = utcFromWibEpoch(wibThisMonthStart);
    const utcNextMonthStart = utcFromWibEpoch(wibNextMonthStart);
    const utcWindowMonthStart = utcFromWibEpoch(wibWindowMonthStart);

    const kpiRows = await dbAll(
      `
      SELECT
        SUM(CASE WHEN \`ts\` >= ? AND \`ts\` < ? THEN 1 ELSE 0 END) AS today_total,
        SUM(CASE WHEN \`ts\` >= ? AND \`ts\` < ? AND \`mode\`='SIANG' THEN 1 ELSE 0 END) AS today_siang,
        SUM(CASE WHEN \`ts\` >= ? AND \`ts\` < ? AND \`mode\`='MALAM' THEN 1 ELSE 0 END) AS today_malam,

        SUM(CASE WHEN \`ts\` >= ? AND \`ts\` < ? THEN 1 ELSE 0 END) AS month_total,
        SUM(CASE WHEN \`ts\` >= ? AND \`ts\` < ? AND \`mode\`='SIANG' THEN 1 ELSE 0 END) AS month_siang,
        SUM(CASE WHEN \`ts\` >= ? AND \`ts\` < ? AND \`mode\`='MALAM' THEN 1 ELSE 0 END) AS month_malam,

        COUNT(*) AS total_count
      FROM \`events\`
      `,
      [
        utcTodayStart, utcTomorrowStart,
        utcTodayStart, utcTomorrowStart,
        utcTodayStart, utcTomorrowStart,
        utcThisMonthStart, utcNextMonthStart,
        utcThisMonthStart, utcNextMonthStart,
        utcThisMonthStart, utcNextMonthStart,
      ]
    );

    const kpi = {
      today_total: kpiRows[0]?.today_total ?? 0,
      today_siang: kpiRows[0]?.today_siang ?? 0,
      today_malam: kpiRows[0]?.today_malam ?? 0,
      month_total: kpiRows[0]?.month_total ?? 0,
      month_siang: kpiRows[0]?.month_siang ?? 0,
      month_malam: kpiRows[0]?.month_malam ?? 0,
      total: kpiRows[0]?.total_count ?? 0,
    };

    const dailyRows = await dbAll(
      `
      SELECT
        DATE_FORMAT(FROM_UNIXTIME(\`ts\` + ?), '%Y-%m-%d') AS day,
        SUM(CASE WHEN \`mode\`='SIANG' THEN 1 ELSE 0 END) AS siang,
        SUM(CASE WHEN \`mode\`='MALAM' THEN 1 ELSE 0 END) AS malam,
        COUNT(*) AS total
      FROM \`events\`
      WHERE \`ts\` >= ?
      GROUP BY day
      ORDER BY day ASC
      `,
      [TZ_OFFSET_SEC, utcWindowDayStart]
    );

    const dailyMap = new Map(dailyRows.map((r) => [r.day, r]));
    const series7d = [];
    for (let i = days - 1; i >= 0; i--) {
      const wibDayEpoch = wibTodayStart - i * 86400;
      const label = fmtDayFromWibEpoch(wibDayEpoch);
      const r = dailyMap.get(label) || { siang: 0, malam: 0, total: 0 };
      series7d.push({
        day: label,
        siang: Number(r.siang) || 0,
        malam: Number(r.malam) || 0,
        total: Number(r.total) || 0,
      });
    }

    const monthlyRows = await dbAll(
      `
      SELECT
        DATE_FORMAT(FROM_UNIXTIME(\`ts\` + ?), '%Y-%m') AS month,
        SUM(CASE WHEN \`mode\`='SIANG' THEN 1 ELSE 0 END) AS siang,
        SUM(CASE WHEN \`mode\`='MALAM' THEN 1 ELSE 0 END) AS malam,
        COUNT(*) AS total
      FROM \`events\`
      WHERE \`ts\` >= ?
      GROUP BY month
      ORDER BY month ASC
      `,
      [TZ_OFFSET_SEC, utcWindowMonthStart]
    );

    const monthMap = new Map(monthlyRows.map((r) => [r.month, r]));
    const series6m = [];
    for (let i = months - 1; i >= 0; i--) {
      const wibMonthEpoch = Math.floor(Date.UTC(y, m - i, 1, 0, 0, 0) / 1000);
      const label = fmtMonthFromWibEpoch(wibMonthEpoch);
      const r = monthMap.get(label) || { siang: 0, malam: 0, total: 0 };
      series6m.push({
        month: label,
        siang: Number(r.siang) || 0,
        malam: Number(r.malam) || 0,
        total: Number(r.total) || 0,
      });
    }

    const compMode = await dbAll(
      `SELECT \`mode\` AS label, COUNT(*) AS count
       FROM \`events\` WHERE \`ts\` >= ?
       GROUP BY \`mode\` ORDER BY count DESC`,
      [utcWindowMonthStart]
    );

    const compZone = await dbAll(
      `SELECT \`zone\` AS label, COUNT(*) AS count
       FROM \`events\` WHERE \`ts\` >= ?
       GROUP BY \`zone\` ORDER BY \`zone\` ASC`,
      [utcWindowMonthStart]
    );

    const compSensor = await dbAll(
      `SELECT \`sensor\` AS label, COUNT(*) AS count
       FROM \`events\` WHERE \`ts\` >= ?
       GROUP BY \`sensor\` ORDER BY count DESC`,
      [utcWindowMonthStart]
    );

    const compActuator = await dbAll(
      `SELECT \`actuator\` AS label, COUNT(*) AS count
       FROM \`events\` WHERE \`ts\` >= ?
       GROUP BY \`actuator\` ORDER BY count DESC`,
      [utcWindowMonthStart]
    );

    const latest = await dbAll(
      `
      SELECT
        \`id\`,
        \`ts\`,
        DATE_FORMAT(FROM_UNIXTIME(\`ts\` + ?), '%Y-%m-%d %H:%i:%s') AS dt_wib,
        \`mode\`, \`sensor\`, \`zone\`, \`message\`, \`actuator\`, \`cooldown_ms\`, \`rssi\`
      FROM \`events\`
      ORDER BY \`ts\` DESC, \`id\` DESC
      LIMIT ?
      `,
      [TZ_OFFSET_SEC, latestLimit]
    );
    
    const recommendation =
      await getRecommendation();

    res.json({
      meta: { days, months, tz: "WIB" },
      kpi,
      series7d,
      series6m,
      composition: {
        mode: compMode,
        zone: compZone,
        sensor: compSensor,
        actuator: compActuator,
      },
      latest,

      recommendation
      
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ START ============
(async () => {
  await initMySqlSchema();
  await loadConfigFromDb();
  configLoaded = true;

  publishConfig(currentConfig);

  // Jalankan cek WA pertama kali 10 detik setelah server aktif
  setTimeout(runHourlyWhatsAppSummary, 10000);

  // Lalu cek setiap 1 menit
  setInterval(runHourlyWhatsAppSummary, WA_CHECK_INTERVAL_MS);

  app.listen(HTTP_PORT, () => {
    console.log(`Web running: http://localhost:${HTTP_PORT}`);
    console.log(`Config page: http://localhost:${HTTP_PORT}/config.html`);
    console.log(
      `MySQL DB: ${process.env.DB_NAME || "pest_dashboard"} @ ${process.env.DB_HOST || "127.0.0.1"}:${process.env.DB_PORT || 3306}`
    );
    console.log(`MQTT config topic: ${TOPIC_CONFIG}`);
    console.log(`WhatsApp target: ${WA_TARGET}`);
  });
})();