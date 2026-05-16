async function fetchJSON(url, opt) {
  const r = await fetch(url, opt);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

function setVal(id, v) {
  const el = document.getElementById(id);
  if (el) el.value = v ?? "";
}

function getNum(id) {
  return Number(document.getElementById(id).value);
}

function setCheck(id, v) {
  const el = document.getElementById(id);
  if (el) el.checked = !!v;
}

function getCheck(id) {
  return document.getElementById(id).checked;
}

function fallback(v, d) {
  return v ?? d;
}

function fillForm(cfg) {
  setVal("day_start_hour", fallback(cfg.day_start_hour, 6));
  setVal("day_end_hour", fallback(cfg.day_end_hour, 18));

  setVal("warmup_ms", fallback(cfg.warmup_ms, 30000));
  setVal("debounce_ms", fallback(cfg.debounce_ms, 200));
  setVal("cooldown_min_ms", fallback(cfg.cooldown_min_ms, 10000));
  setVal("cooldown_max_ms", fallback(cfg.cooldown_max_ms, 20000));

  setVal("servo_idle", fallback(cfg.servo_idle, 0));

  setVal("servo_day_min", fallback(cfg.servo_day_min, 30));
  setVal("servo_day_max", fallback(cfg.servo_day_max, 120));
  setVal("day_move_count_min", fallback(cfg.day_move_count_min, 3));
  setVal("day_move_count_max", fallback(cfg.day_move_count_max, 7));
  setVal("day_step_delay_min_ms", fallback(cfg.day_step_delay_min_ms, 150));
  setVal("day_step_delay_max_ms", fallback(cfg.day_step_delay_max_ms, 600));

  // support config lama yang masih punya servo_night_angle
  const oldNightAngle = fallback(cfg.servo_night_angle, 90);

  setVal("servo_night_min", fallback(cfg.servo_night_min, oldNightAngle));
  setVal("servo_night_max", fallback(cfg.servo_night_max, oldNightAngle));
  setVal("night_move_count_min", fallback(cfg.night_move_count_min, 3));
  setVal("night_move_count_max", fallback(cfg.night_move_count_max, 6));
  setVal("night_step_delay_min_ms", fallback(cfg.night_step_delay_min_ms, 120));
  setVal("night_step_delay_max_ms", fallback(cfg.night_step_delay_max_ms, 450));

  setVal("buzzer_on_min_ms", fallback(cfg.buzzer_on_min_ms, 400));
  setVal("buzzer_on_max_ms", fallback(cfg.buzzer_on_max_ms, 800));
  setVal("buzzer_off_min_ms", fallback(cfg.buzzer_off_min_ms, 1000));
  setVal("buzzer_off_max_ms", fallback(cfg.buzzer_off_max_ms, 2000));

  const pe = cfg.pir_enabled || [true, true, true, true];
  setCheck("pir1", pe[0]);
  setCheck("pir2", pe[1]);
  setCheck("pir3", pe[2]);
  setCheck("pir4", pe[3]);
}

function readForm() {
  return {
    day_start_hour: getNum("day_start_hour"),
    day_end_hour: getNum("day_end_hour"),

    warmup_ms: getNum("warmup_ms"),
    debounce_ms: getNum("debounce_ms"),
    cooldown_min_ms: getNum("cooldown_min_ms"),
    cooldown_max_ms: getNum("cooldown_max_ms"),

    servo_idle: getNum("servo_idle"),

    servo_day_min: getNum("servo_day_min"),
    servo_day_max: getNum("servo_day_max"),
    day_move_count_min: getNum("day_move_count_min"),
    day_move_count_max: getNum("day_move_count_max"),
    day_step_delay_min_ms: getNum("day_step_delay_min_ms"),
    day_step_delay_max_ms: getNum("day_step_delay_max_ms"),

    servo_night_min: getNum("servo_night_min"),
    servo_night_max: getNum("servo_night_max"),
    night_move_count_min: getNum("night_move_count_min"),
    night_move_count_max: getNum("night_move_count_max"),
    night_step_delay_min_ms: getNum("night_step_delay_min_ms"),
    night_step_delay_max_ms: getNum("night_step_delay_max_ms"),

    buzzer_on_min_ms: getNum("buzzer_on_min_ms"),
    buzzer_on_max_ms: getNum("buzzer_on_max_ms"),
    buzzer_off_min_ms: getNum("buzzer_off_min_ms"),
    buzzer_off_max_ms: getNum("buzzer_off_max_ms"),

    pir_enabled: [
      getCheck("pir1"),
      getCheck("pir2"),
      getCheck("pir3"),
      getCheck("pir4")
    ]
  };
}

async function load() {
  const d = await fetchJSON("/api/config");
  document.getElementById("topicBox").textContent = d.topic;
  fillForm(d.config || {});
  document.getElementById("statusBox").textContent = "Config loaded.";
}

document.getElementById("reloadBtn").addEventListener("click", () => {
  load().catch(e => alert(e.message));
});

document.getElementById("saveBtn").addEventListener("click", async () => {
  try {
    const payload = readForm();
    const d = await fetchJSON("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    document.getElementById("statusBox").textContent = "Tersimpan & terkirim ke MQTT ✅";
    fillForm(d.config || payload);
  } catch (e) {
    alert(e.message);
  }
});

load().catch(e => alert(e.message));