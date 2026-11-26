'use client';
import { useEffect, useState } from 'react';

type T = { token_no: number; status: string; department: string; room: string | null };

export function Board({ slug, name, color, keyParam, departmentId }: { slug: string; name: string; color: string; keyParam: string; departmentId?: string }) {
  const [rows, setRows] = useState<T[]>([]);
  const [at, setAt] = useState<string>('');
  const [err, setErr] = useState('');
  useEffect(() => {
    let alive = true;
    const load = () => fetch(`/api/public/v1/${slug}/board?key=${encodeURIComponent(keyParam)}${departmentId ? `&departmentId=${departmentId}` : ''}`)
      .then((r) => r.json()).then((j) => { if (!alive) return; if (j.error) setErr(j.error.message); else { setRows(j.tickets); setAt(j.updatedAt); setErr(''); } })
      .catch(() => alive && setErr('Connection lost — retrying'));
    load(); const id = setInterval(load, 8000);
    return () => { alive = false; clearInterval(id); };
  }, [slug, keyParam, departmentId]);
  const called = rows.filter((r) => r.status === 'called');
  const waiting = rows.filter((r) => r.status === 'waiting');
  return (
    <main className="board" style={{ ['--brand' as string]: color }}>
      <header><h1>{name}</h1><span>{at ? `Updated ${new Date(at).toLocaleTimeString()}` : ''}</span></header>
      {err && <p className="flash err">{err}</p>}
      <section><h2>Now calling</h2><div className="board-called">{called.length === 0 ? <p>—</p> : called.map((r) => (
        <div key={`${r.department}-${r.token_no}`} className="board-tile on"><b>{r.token_no}</b><span>{r.room ?? r.department}</span></div>))}</div></section>
      <section><h2>Waiting</h2><div className="board-wait">{waiting.map((r) => <div key={`${r.department}-${r.token_no}`} className="board-tile"><b>{r.token_no}</b><span>{r.department}</span></div>)}</div></section>
      <footer>Times are estimates. Please tell reception if you feel unwell while waiting.</footer>
    </main>
  );
}
