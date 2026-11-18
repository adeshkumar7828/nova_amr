import { useEffect, useRef, useState, useCallback } from 'react';

/*
  useNova - the link to the Nova server (ws://<page host>/ui).
  Reconnects by itself. Returns live status + telemetry and a send() function.
*/
export function useNova() {
  const wsRef = useRef(null);
  const [online, setOnline] = useState(false);       // page <-> server
  const [status, setStatus] = useState(null);        // server's status message
  const [telemetry, setTelemetry] = useState(null);  // latest from the ESP32
  const [safe, setSafe] = useState(null);            // LiDAR view + Auto forward state (from the server)

  useEffect(() => {
    let stopped = false;
    let retry;
    function connect() {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ui`);
      wsRef.current = ws;
      ws.onopen = () => setOnline(true);
      ws.onclose = () => {
        setOnline(false);
        if (!stopped) retry = setTimeout(connect, 1000);
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (e) => {
        let m;
        try { m = JSON.parse(e.data); } catch { return; }
        if (m.type === 'status') setStatus(m);
        else if (m.type === 'telemetry') setTelemetry({ ...m, at: Date.now() });
        else if (m.type === 'safe') setSafe({ ...m, at: Date.now() });
      };
    }
    connect();
    return () => { stopped = true; clearTimeout(retry); wsRef.current?.close(); };
  }, []);

  const send = useCallback((msg) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  return { online, status, telemetry, safe, send };
}
