import { useEffect, useRef, useState } from 'react';
import { useNova } from './useNova.js';
import SafeDrive from './SafeDrive.jsx';

/*
  Nova control page. Two pages (tabs):
    Drive       plain manual driving
    Safe drive  same pad, but the server checks forward against the LiDAR; + Auto forward
  Hold a button (or W A S D / arrow keys) to drive; let go and Nova stops.
  While held, the page sends the command 10x per second - if those messages
  stop for any reason, the server and the ESP32 both stop the motors.
*/

const PAD = [
  { id: 'fl', label: '↖', lin: 1, ang: 0.5 },
  { id: 'f', label: '▲', lin: 1, ang: 0 },
  { id: 'fr', label: '↗', lin: 1, ang: -0.5 },
  { id: 'l', label: '◀', lin: 0, ang: 1 },
  { id: 'stop', label: 'STOP' },
  { id: 'r', label: '▶', lin: 0, ang: -1 },
  { id: 'bl', label: '↙', lin: -1, ang: 0.5 },
  { id: 'b', label: '▼', lin: -1, ang: 0 },
  { id: 'br', label: '↘', lin: -1, ang: -0.5 },
];

const KEYS = {
  w: 'f', arrowup: 'f', s: 'b', arrowdown: 'b',
  a: 'l', arrowleft: 'l', d: 'r', arrowright: 'r',
};

export default function App() {
  const { online, status, telemetry, safe, send } = useNova();
  const [tab, setTab] = useState(() => { try { return localStorage.getItem('novaTab') || 'drive'; } catch { return 'drive'; } });
  const [speed, setSpeed] = useState(0.6);
  const [turn, setTurn] = useState(0.5);
  const [held, setHeld] = useState(null);          // pad button being held (for highlight)
  const [keysDown, setKeysDown] = useState([]);    // direction keys held
  const [showSettings, setShowSettings] = useState(false);

  // what to send right now: {type:'drive', linear, angular} or {type:'wheel', left, right}
  const cmdRef = useRef(null);
  const wasMovingRef = useRef(false);

  const robotUp = !!status?.robot?.connected;
  const fresh = telemetry && Date.now() - telemetry.at < 1500;

  // ---- work out the command from what is held ----
  useEffect(() => {
    let lin = 0, ang = 0;
    if (held?.type === 'wheel') {
      cmdRef.current = { type: 'wheel', left: held.left, right: held.right };
      return;
    }
    if (held && held.lin !== undefined) { lin = held.lin; ang = held.ang; }
    else if (keysDown.length) {
      for (const k of keysDown) {
        if (k === 'f') lin += 1;
        if (k === 'b') lin -= 1;
        if (k === 'l') ang += 1;
        if (k === 'r') ang -= 1;
      }
      if (lin !== 0 && ang !== 0) ang *= 0.5;       // W+A = gentle curve, not a spin
    }
    cmdRef.current = (lin || ang)
      ? { type: 'drive', linear: +(lin * speed).toFixed(2), angular: +(ang * turn).toFixed(2), safe: tab === 'safe' }
      : null;
  }, [held, keysDown, speed, turn, tab]);

  function openTab(t) {
    setHeld(null); setKeysDown([]);
    setTab(t);
    try { localStorage.setItem('novaTab', t); } catch { /* ignore */ }
  }

  // ---- send loop: 10x per second while something is held ----
  useEffect(() => {
    const t = setInterval(() => {
      const c = cmdRef.current;
      if (c) { send(c); wasMovingRef.current = true; }
      else if (wasMovingRef.current) { send({ type: 'drive', linear: 0, angular: 0 }); wasMovingRef.current = false; }
    }, 100);
    return () => clearInterval(t);
  }, [send]);

  // ---- keyboard ----
  useEffect(() => {
    const down = (e) => {
      if (e.target.tagName === 'INPUT') return;
      const k = e.key.toLowerCase();
      if (k === ' ') { e.preventDefault(); stopNow(); return; }
      const dir = KEYS[k];
      if (!dir) return;
      e.preventDefault();
      setKeysDown((ks) => (ks.includes(dir) ? ks : [...ks, dir]));
    };
    const up = (e) => {
      const dir = KEYS[e.key.toLowerCase()];
      if (dir) setKeysDown((ks) => ks.filter((x) => x !== dir));
    };
    const blur = () => { setKeysDown([]); setHeld(null); };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    document.addEventListener('visibilitychange', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
      document.removeEventListener('visibilitychange', blur);
    };
  }, []);

  function stopNow() {
    setHeld(null);
    setKeysDown([]);
    cmdRef.current = null;
    wasMovingRef.current = false;
    send({ type: 'stop' });
  }

  // hold-to-drive handlers for any button
  function holdProps(value) {
    return {
      onPointerDown: (e) => { e.preventDefault(); e.currentTarget.setPointerCapture?.(e.pointerId); setHeld(value); },
      onPointerUp: () => setHeld(null),
      onPointerCancel: () => setHeld(null),
      onLostPointerCapture: () => setHeld(null),
      onContextMenu: (e) => e.preventDefault(),
    };
  }

  const activeDir = held?.id || (keysDown.length === 1 ? keysDown[0] : null);
  const s = status?.settings;

  const padEl = (
    <>
          <div className="pad">
            {PAD.map((b) =>
              b.id === 'stop' ? (
                <button key={b.id} className="btn stop" onPointerDown={stopNow}>STOP</button>
              ) : (
                <button
                  key={b.id}
                  className={`btn dir ${b.id.length === 2 ? 'diag' : ''} ${activeDir === b.id ? 'on' : ''}`}
                  disabled={!robotUp}
                  {...holdProps(b)}
                >
                  {b.label}
                </button>
              )
            )}
          </div>
          <p className="hint">Hold to drive · keys <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> or arrows · <kbd>Space</kbd> = stop</p>

    </>
  );
  const slidersEl = (
    <>
          <Slider label="Speed" value={speed} onChange={setSpeed} min={0.1} max={1} step={0.05} pct />
          <Slider label="Turn" value={turn} onChange={setTurn} min={0.1} max={1} step={0.05} pct />
    </>
  );

  return (
    <div className="app">
      <header>
        <div className="brand">
          <span className="logo">N</span>
          <div>
            <h1>Nova AMR</h1>
            <small>{tab === 'safe' ? 'Safe drive · LiDAR' : 'Manual drive'}</small>
          </div>
        </div>
        <div className="chips">
          <Chip ok={online} label={online ? 'Server' : 'Server offline'} />
          <Chip ok={robotUp} label={robotUp ? `Nova ${status.robot.ip || ''}` : 'Nova not connected'} />
          {robotUp && fresh && <Chip ok={telemetry.rssi > -75} label={`Wi-Fi ${telemetry.rssi} dBm`} />}
        </div>
      </header>

      <nav className="tabs">
        <button className={tab === 'drive' ? 'on' : ''} onClick={() => openTab('drive')}>Drive</button>
        <button className={tab === 'safe' ? 'on' : ''} onClick={() => openTab('safe')}>
          Safe drive · Auto forward {safe?.fresh && <i className="dot" />}
        </button>
      </nav>

      {!robotUp && (
        <div className="banner">
          Waiting for Nova… Power the ESP32, and check it's on the same Wi-Fi as this computer.
          The ESP32's blue LED blinks while searching and stays on once connected.
        </div>
      )}

      {tab === 'safe' ? (
        <SafeDrive safe={safe} status={status} telemetry={telemetry} send={send} pad={padEl} sliders={slidersEl} />
      ) : (
      <main>
        <section className="card drive">
          {padEl}
          {slidersEl}
        </section>

        <section className="card">
          <h2>Wheels</h2>
          <WheelBar label="Left" value={fresh ? telemetry.left : 0} />
          <WheelBar label="Right" value={fresh ? telemetry.right : 0} />
          <div className="stats">
            <Stat k="Speed cap" v={s ? `${Math.round(s.maxPower * 100)}%` : '–'} />
            <Stat k="Uptime" v={fresh ? `${Math.round(telemetry.uptimeMs / 1000)} s` : '–'} />
            <Stat k="Watchdog stops" v={fresh ? telemetry.watchdog : '–'} />
          </div>

          <button className="link" onClick={() => setShowSettings((v) => !v)}>
            {showSettings ? '▾ Hide settings' : '▸ Settings & wheel test'}
          </button>

          {showSettings && s && (
            <div className="settings">
              <Slider label="Speed cap" value={s.maxPower} min={0.1} max={1} step={0.05} pct
                onChange={(v) => send({ type: 'settings', maxPower: v })}
                note="Keep ≤ 60% until the 20 A converter is fitted" />
              <Slider label="Min duty" value={s.minDuty} min={0} max={150} step={5}
                onChange={(v) => send({ type: 'settings', minDuty: v })}
                note="Raise if the wheels hum but don't turn at low speed" />
              <Slider label="Left trim" value={s.trimLeft} min={0.5} max={1} step={0.01} pct
                onChange={(v) => send({ type: 'settings', trimLeft: v })} />
              <Slider label="Right trim" value={s.trimRight} min={0.5} max={1} step={0.01} pct
                onChange={(v) => send({ type: 'settings', trimRight: v })}
                note="If Nova curves while going straight, lower the faster side" />
              <div className="toggles">
                <Toggle label="Invert left" on={s.invertLeft} onChange={(v) => send({ type: 'settings', invertLeft: v })} />
                <Toggle label="Invert right" on={s.invertRight} onChange={(v) => send({ type: 'settings', invertRight: v })} />
              </div>

              <h3>One-wheel test (hold, wheels off the ground)</h3>
              <div className="wheeltest">
                <button className="btn small" disabled={!robotUp} {...holdProps({ type: 'wheel', left: 0.4, right: 0 })}>Left ▲</button>
                <button className="btn small" disabled={!robotUp} {...holdProps({ type: 'wheel', left: -0.4, right: 0 })}>Left ▼</button>
                <button className="btn small" disabled={!robotUp} {...holdProps({ type: 'wheel', left: 0, right: 0.4 })}>Right ▲</button>
                <button className="btn small" disabled={!robotUp} {...holdProps({ type: 'wheel', left: 0, right: -0.4 })}>Right ▼</button>
              </div>
              <button className="link" onClick={() => send({ type: 'settings', reset: true })}>Reset settings to defaults</button>
            </div>
          )}
        </section>
      </main>
      )}

      <footer>
        {status?.addresses?.length > 0 && <>Open on a phone (same Wi-Fi): {status.addresses.join('  ·  ')}</>}
      </footer>
    </div>
  );
}

function Chip({ ok, label }) {
  return <span className={`chip ${ok ? 'ok' : 'bad'}`}><i />{label}</span>;
}

function Slider({ label, value, onChange, min, max, step, pct, note }) {
  return (
    <label className="slider">
      <span className="row">
        <span>{label}</span>
        <b>{pct ? `${Math.round(value * 100)}%` : value}</b>
      </span>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))} />
      {note && <small>{note}</small>}
    </label>
  );
}

function Toggle({ label, on, onChange }) {
  return (
    <button className={`toggle ${on ? 'on' : ''}`} onClick={() => onChange(!on)}>
      <span className="knob" /> {label}
    </button>
  );
}

function WheelBar({ label, value }) {
  const pct = Math.round(Math.abs(value) * 100);
  return (
    <div className="wheel">
      <span>{label}</span>
      <div className="track">
        <div className="mid" />
        <div className={`fill ${value < 0 ? 'rev' : ''}`}
          style={value >= 0 ? { left: '50%', width: `${pct / 2}%` } : { right: '50%', width: `${pct / 2}%` }} />
      </div>
      <b>{value < 0 ? '−' : ''}{pct}%</b>
    </div>
  );
}

function Stat({ k, v }) {
  return <div className="stat"><small>{k}</small><b>{v}</b></div>;
}
