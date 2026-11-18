import { useEffect, useRef, useState } from 'react';

/*
  Safe drive page (same as Scout's Safe drive tab).
  - The pad here sends {type:'drive', safe:true}: the SERVER checks every forward
    command against the LiDAR (slow down / refuse). Reverse and turning always work.
  - Auto forward: Nova drives forward by itself and turns away from obstacles.
  This page only shows what the server decided; it never decides itself.
*/

const FIELDS = [
  // key, label, unit, multiplier (page value = setting * mul), min, max
  ['stopCm', 'Stop at', 'cm', 1, 15, 200],
  ['slowCm', 'Slow down from', 'cm', 1, 25, 400],
  ['widthCm', 'Robot width', 'cm', 1, 8, 100],
  ['frontCm', 'LiDAR to front edge', 'cm', 1, 0, 60],
  ['autoSpeed', 'Auto speed', '%', 100, 20, 100],
  ['autoTurn', 'Auto turn', '%', 100, 20, 100],
];

export default function SafeDrive({ safe, status, telemetry, send, pad, sliders }) {
  const fresh = !!safe && safe.fresh && Date.now() - safe.at < 1500;
  const zone = fresh ? safe.zone : 'nodata';
  const autoOn = !!safe && (safe.auto.state === 'drive' || safe.auto.state === 'turn');
  const robotUp = !!status?.robot?.connected;

  return (
    <main className="safe">
      <section className="card drive">
        <h2>Safe drive <Pill ok={fresh} label={fresh ? 'LiDAR: live' : 'LiDAR: no data'} warn={fresh && zone !== 'clear'} /></h2>
        {pad}
        <p className="hint">Forward is slowed or refused when something is in front. Reverse and turning always work.</p>
        {sliders}
        <button
          className={`btn wide ${autoOn ? 'danger' : 'primary'}`}
          disabled={!robotUp && !autoOn}
          onClick={() => send({ type: 'safe', action: autoOn ? 'autoStop' : 'autoStart' })}
        >
          {autoOn ? '■ Stop auto forward' : '▶ Auto forward'}
        </button>
        <AutoStatus auto={safe?.auto} />
      </section>

      <section className="card">
        <h2>Around Nova {fresh && safe.ageMs !== null && <small className="muted"> scan age {safe.ageMs} ms</small>}</h2>
        <div className="ahead">
          <small>Clear space in front of Nova</small>
          <b>{fresh ? (safe.ahead >= 590 ? 'clear (6 m+)' : `${safe.ahead} cm`) : 'no data'}</b>
        </div>
        <Verdict safe={safe} zone={zone} />
        <Radar safe={safe} fresh={fresh} />
        <p className="hint">Top-down view, front is up, rings every 50 cm. Blue box = Nova. Red strip = stop zone, amber = slow zone.</p>
      </section>

      <LidarLink status={status} telemetry={telemetry} fresh={fresh} send={send} />

      <Settings safe={safe} send={send} />
    </main>
  );
}

function Pill({ ok, warn, label }) {
  return <span className={`chip ${ok ? (warn ? 'warn' : 'ok') : 'bad'}`}><i />{label}</span>;
}

function AutoStatus({ auto }) {
  const label = { drive: 'driving', turn: 'turning', stuck: 'stopped (stuck)', idle: 'off' }[auto?.state] || auto?.state || 'off';
  return (
    <div className={`status ${auto?.cls || ''}`}>
      <b>Auto forward: {label}</b>
      <span>{auto?.msg || 'Drives forward on its own and turns away from obstacles. STOP, Space or any drive button cancels it.'}</span>
    </div>
  );
}

function Verdict({ safe, zone }) {
  if (zone === 'nodata') return (
    <div className="verdict nodata">No LiDAR data: forward is refused.<small>See “LiDAR link” below for what is missing.</small></div>
  );
  const refused = safe.refused ? ' Forward command refused.' : '';
  if (zone === 'blocked') return (
    <div className="verdict bad">Blocked: obstacle {safe.ahead} cm ahead.{refused}<small>Reverse or turn away. Forward works again above {safe.st.stopCm} cm.</small></div>
  );
  if (zone === 'slow') return (
    <div className="verdict warn">Slowing down: obstacle {safe.ahead} cm ahead.<small>Forward speed is reduced below {safe.st.slowCm} cm.</small></div>
  );
  return <div className="verdict ok">Clear: full speed.<small>Nothing within {safe.st.slowCm} cm in Nova's path.</small></div>;
}

function Radar({ safe, fresh }) {
  const ref = useRef(null);
  const [size, setSize] = useState(0);

  useEffect(() => {
    const ro = new ResizeObserver(() => setSize(ref.current?.clientWidth || 0));
    if (ref.current) ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const c = ref.current;
    if (!c || !safe || c.clientWidth === 0) return;
    const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
    const dpr = window.devicePixelRatio || 1, W = c.clientWidth, H = c.clientHeight;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    const st = safe.st, R = 300, s = Math.min(W, H) / 2 / R, cx = W / 2, cy = H / 2;
    const P = (x, y) => [cx - y * s, cy - x * s];             // robot frame: x ahead, y left
    const rect = (x0, x1, y0, y1) => { const [ax, ay] = P(x1, y1), [bx, by] = P(x0, y0); g.fillRect(ax, ay, bx - ax, by - ay); };
    g.strokeStyle = css('--line'); g.lineWidth = 1; g.fillStyle = css('--muted'); g.font = '11px system-ui';
    for (let r = 50; r <= R; r += 50) { g.beginPath(); g.arc(cx, cy, r * s, 0, Math.PI * 2); g.stroke(); if (r % 100 === 0) g.fillText(`${r / 100} m`, cx + 3, cy - r * s + 12); }
    const hw = st.widthCm / 2 + st.marginCm;
    g.globalAlpha = 0.18; g.fillStyle = css('--rev'); rect(st.frontCm + st.stopCm, st.frontCm + st.slowCm, -hw, hw);
    g.globalAlpha = 0.25; g.fillStyle = css('--bad'); rect(st.frontCm, st.frontCm + st.stopCm, -hw, hw);
    g.globalAlpha = 1;
    g.fillStyle = css('--accent'); rect(-Math.max(st.frontCm, 10), st.frontCm, -st.widthCm / 2, st.widthCm / 2);
    g.fillStyle = '#fff'; g.beginPath(); const [tx, ty] = P(st.frontCm - 3, 0); g.arc(tx, ty, 2.5, 0, Math.PI * 2); g.fill();
    if (fresh) {
      g.fillStyle = css('--text');
      safe.radar.forEach((r, k) => {
        if (!r || r > R * 1.5) return;
        const a = (k * 5 + 2.5) * Math.PI / 180, [px, py] = P(r * Math.cos(a), r * Math.sin(a));
        if (px < 0 || py < 0 || px > W || py > H) return;
        g.fillRect(px - 2, py - 2, 4, 4);
      });
    } else {
      g.fillStyle = css('--muted'); g.font = '14px system-ui'; g.textAlign = 'center';
      g.fillText('No LiDAR data', cx, cy + 70); g.textAlign = 'start';
    }
  }, [safe, fresh, size]);

  return <canvas ref={ref} className="radar" />;
}

function LidarLink({ status, telemetry, fresh, send }) {
  const l = telemetry?.lidar;
  const st = status?.settings || {};
  const lidarSt = status?.lidar || {};
  const reader = lidarSt.reader;
  const source = st.lidarSource || 'laptop';
  const robotUp = !!status?.robot?.connected;
  const nova = status?.robot?.ip;
  const setS = (patch) => send({ type: 'settings', ...patch });

  const readerOk = reader?.state === 'scanning';
  const steps = source === 'laptop' ? [
    { ok: robotUp, label: 'Nova connected', note: robotUp ? nova : 'power Nova / same Wi-Fi' },
    { ok: robotUp && !!lidarSt.bridgePort, label: 'LiDAR bridge in firmware', note: robotUp ? (lidarSt.bridgePort ? `port ${lidarSt.bridgePort}` : 'upload the new firmware') : '–' },
    { ok: readerOk, label: 'Laptop reading the LiDAR', note: reader ? reader.msg : '–', bad: reader?.state === 'error' },
    { ok: fresh, label: 'Scans arriving', note: fresh && reader ? `${reader.scansPerSec} turns/s · ${reader.pointsPerScan} points` : '–' },
  ] : [
    { ok: robotUp, label: 'Nova connected', note: robotUp ? nova : 'power Nova / same Wi-Fi' },
    { ok: robotUp && !!lidarSt.bridgePort, label: 'LiDAR bridge in firmware', note: robotUp ? (lidarSt.bridgePort ? `port ${lidarSt.bridgePort}` : 'upload the new firmware') : '–' },
    { ok: !!l?.client, label: 'ROS connected to the LiDAR', note: l ? (l.client ? `${Math.round((l.upBps || 0) / 1024)} KB/s from LiDAR` : 'run the ROS command below') : '–' },
    { ok: fresh, label: 'Scans reaching this server', note: fresh ? `from ROS (${lidarSt.scansFrom || '?'})` : 'scan_to_server starts with the launch' },
  ];

  const addrs = status?.addresses || [];
  const same = nova ? addrs.find((a) => a.split('//')[1]?.split('.').slice(0, 3).join('.') === nova.split('.').slice(0, 3).join('.')) : null;
  const server = same || addrs[0] || `http://${location.host}`;
  const cmd1 = 'ros2 launch nova_bringup lidar.launch.py';
  const cmd2 = `ros2 launch nova_bringup lidar.launch.py rviz:=false server:=${server}`;

  return (
    <section className="card full">
      <h2>
        LiDAR link
        <span className="seg">
          <button className={source === 'laptop' ? 'on' : ''} onClick={() => setS({ lidarSource: 'laptop' })}>Laptop (direct)</button>
          <button className={source === 'jetson' ? 'on' : ''} onClick={() => setS({ lidarSource: 'jetson' })}>ROS</button>
        </span>
      </h2>
      <div className="steps">
        {steps.map((s, i) => (
          <div key={i} className={`step ${s.ok ? 'ok' : s.bad ? 'bad' : ''}`}><i>{s.ok ? '✓' : i + 1}</i><b>{s.label}</b><small>{s.note}</small></div>
        ))}
      </div>

      {source === 'laptop' ? (
        <>
          <div className="lidar-opts">
            <label className="f">
              <span>LiDAR arrow points to Nova's</span>
              <select value={st.lidarArrowDeg ?? 0} onChange={(e) => setS({ lidarArrowDeg: Number(e.target.value) })}>
                <option value={0}>front</option><option value={90}>left side</option>
                <option value={180}>back</option><option value={270}>right side</option>
              </select>
            </label>
            <button className={`toggle ${st.lidarMirror ? 'on' : ''}`} onClick={() => setS({ lidarMirror: !st.lidarMirror })}>
              <span className="knob" /> Mirror left/right
            </button>
            <button className="btn small" onClick={() => send({ type: 'lidar', action: 'restart' })} disabled={!robotUp}>↻ Restart LiDAR</button>
          </div>
          <p className="hint">
            No Jetson needed: this laptop reads the LiDAR straight from Nova over Wi-Fi. It spins while this page (or the Drive page) is open
            and stops about 10 s after the last page closes. <b>Check the direction once:</b> hold your hand in front of Nova → dots at the
            top of the radar; hand on Nova's left → dots on the left. If front/back is wrong change “arrow points”; if only left/right is
            swapped turn on “Mirror”.
          </p>
        </>
      ) : (
        <>
          <h3>In ROS 2 (WSL Ubuntu on this laptop, or the Jetson later):</h3>
          <Cmd n="1" text={cmd1} hint="Laptop (WSL): LiDAR driver over Wi-Fi + Nova's outline + RViz + scans back to this page. First time: bash &quot;/mnt/d/Mobilise/Nova AMR/ros/setup_wsl.sh&quot;" />
          <Cmd n="2" text={cmd2} hint="From another computer (e.g. the Jetson): same, without RViz, pointing at this server." />
          <p className="hint">Only one LiDAR reader at a time: “ROS” here lets go of the laptop reader. Ctrl+C in ROS stops the LiDAR; click “Laptop (direct)” to go back.</p>
        </>
      )}
    </section>
  );
}

function Cmd({ n, text, hint }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="cmd">
      <span className="n">{n}</span>
      <code>{text}</code>
      <button className="btn small" onClick={() => {
        try { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1200); } catch { /* ignore */ }
      }}>{copied ? 'Copied' : 'Copy'}</button>
      <small>{hint}</small>
    </div>
  );
}

function Settings({ safe, send }) {
  const [vals, setVals] = useState({});
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!safe || dirty) return;
    const v = {};
    for (const [k, , , mul] of FIELDS) v[k] = Math.round(safe.st[k] * mul);
    setVals(v);
  }, [safe, dirty]);

  function save() {
    const settings = {};
    for (const [k, , , mul] of FIELDS) if (vals[k] !== '' && vals[k] !== undefined) settings[k] = Number(vals[k]) / mul;
    send({ type: 'safe', action: 'settings', settings });
    setDirty(false);
  }
  return (
    <section className="card full">
      <h2>Safe drive settings <small className="muted">saved on the server</small></h2>
      <div className="form">
        {FIELDS.map(([k, label, unit, , min, max]) => (
          <label key={k} className="f">
            <span>{label}</span>
            <span className="inp">
              <input type="number" min={min} max={max} value={vals[k] ?? ''}
                onChange={(e) => { setDirty(true); setVals({ ...vals, [k]: e.target.value }); }} />
              <em>{unit}</em>
            </span>
          </label>
        ))}
        <button className="btn primary" onClick={save} disabled={!safe}>Save</button>
      </div>
      <p className="hint">
        <b>Measure Nova first:</b> robot width includes the wheels; “LiDAR to front edge” is how far the LiDAR's centre sits behind Nova's front.
        Distances are from the front edge. Auto speed/turn are on top of the speed cap in Settings on the Drive page.
      </p>
    </section>
  );
}
