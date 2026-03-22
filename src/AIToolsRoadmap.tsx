import * as React from 'react';
import { useState, useMemo, useEffect } from 'react';
import * as msalBrowser from '@azure/msal-browser';

export interface IAIToolsRoadmapProps {
  context: null;
}

// ─── msal config ──────────────────────────────────────────────────────────────
const CLIENT_ID = 'c36b261b-8efe-41c3-8080-79c6d6f3a936';
const TENANT_ID = '781cf99d-c6ca-4970-940e-26a3d0ff7f2a';
const SITE_HOST = 'servicenow.sharepoint.com';
const SITE_PATH = '/sites/ImpactEngineeringUTG';
const SCOPES    = ['https://graph.microsoft.com/Sites.ReadWrite.All'];

const msalInstance = new msalBrowser.PublicClientApplication({
  auth: {
    clientId: CLIENT_ID,
    authority: `https://login.microsoftonline.com/${TENANT_ID}`,
    redirectUri: window.location.origin,
  },
  cache: { cacheLocation: 'sessionStorage'},
});

async function getToken(): Promise<string> {
  await msalInstance.initialize();
  const accounts = msalInstance.getAllAccounts();
  if (accounts.length) {
    try {
      const r = await msalInstance.acquireTokenSilent({ scopes: SCOPES, account: accounts[0] });
      return r.accessToken;
    } catch {}
  }
  const r = await msalInstance.loginPopup({ scopes: SCOPES });
  return r.accessToken;
}

async function gql(method: string, path: string, body?: object): Promise<any> {
  const token = await getToken();
  const resp = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) { const e = await resp.text(); throw new Error(e); }
  if (method === 'DELETE') return null;
  return resp.json();
}

// ─── graph helpers ────────────────────────────────────────────────────────────
let _siteId: string | null = null;
const _listIds: Record<string, string> = {};

async function getSiteId(): Promise<string> {
  if (_siteId) return _siteId;
  const d = await gql('GET', `/sites/${SITE_HOST}:${SITE_PATH}`);
  _siteId = d.id;
  return _siteId!;
}

async function getListId(name: string): Promise<string> {
  if (_listIds[name]) return _listIds[name];
  const sid = await getSiteId();
  const d = await gql('GET', `/sites/${sid}/lists?$filter=displayName eq '${name}'`);
  if (!d.value.length) throw new Error(`List "${name}" not found on SharePoint.`);
  _listIds[name] = d.value[0].id;
  return _listIds[name];
}

async function getItems(listName: string): Promise<any[]> {
  const sid = await getSiteId();
  const lid = await getListId(listName);
  let items: any[] = [];
  let next: string | null = `/sites/${sid}/lists/${lid}/items?expand=fields`;
  while (next) {
    const d: any = await gql('GET', next);
    items = [...items, ...d.value];
    next = d['@odata.nextLink']
      ? d['@odata.nextLink'].replace('https://graph.microsoft.com/v1.0', '')
      : null;
  }
  return items.map((i: any) => ({ _id: i.id, ...i.fields }));
}

async function createItem(listName: string, fields: object): Promise<any> {
  const sid = await getSiteId();
  const lid = await getListId(listName);
  const d = await gql('POST', `/sites/${sid}/lists/${lid}/items`, { fields });
  return { _id: d.id, ...d.fields };
}

async function updateItem(listName: string, itemId: string, fields: object): Promise<void> {
  const sid = await getSiteId();
  const lid = await getListId(listName);
  await gql('PATCH', `/sites/${sid}/lists/${lid}/items/${itemId}/fields`, fields);
}

async function deleteItem(listName: string, itemId: string): Promise<void> {
  const sid = await getSiteId();
  const lid = await getListId(listName);
  await gql('DELETE', `/sites/${sid}/lists/${lid}/items/${itemId}`);
}

// ─── data mapping ─────────────────────────────────────────────────────────────
function rowToTool(row: any, mRows: any[], sRows: any[]): any {
  const name = row.name || row.Title || '';
  return {
    id: row._id, _spId: row._id, name,
    category: row.category || 'hsd',
    status:   row.status   || 'Backlog',
    impact:   row.impact   || 'Medium',
    description: row.description || '',
    owners: row.owners ? row.owners.split(',').map((s: string) => s.trim()).filter(Boolean) : [],
    w1Date:        row.w1Date        ? row.w1Date.split('T')[0]        : null,
    targetEndDate: row.targetEndDate ? row.targetEndDate.split('T')[0] : null,
    flaggedProgressWeek: row.flaggedProgressWeek || null,
    notes: row.notes || '',
    milestones: mRows
      .filter((m: any) => (m.tool_name || '').trim() === name)
      .map((m: any) => ({
        id: m._id, _spId: m._id,
        label: m.label || m.Title || '',
        week:  parseInt(m.week) || 1,
        done:  !!m.done,
        targetDate: m.targetDate ? m.targetDate.split('T')[0] : null,
      })),
    subtasks: sRows
      .filter((s: any) => (s.tool_name || '').trim() === name)
      .map((s: any) => ({
        id: s._id, _spId: s._id,
        label: s.label || s.Title || '',
        done:  !!s.done,
      })),
  };
}

async function loadFromSP(): Promise<any[]> {
  const [tRows, mRows, sRows] = await Promise.all([
    getItems('RoadmapTools'),
    getItems('RoadmapMilestones'),
    getItems('RoadmapSubtasks'),
  ]);
  return tRows.map((r: any) => rowToTool(r, mRows, sRows));
}

// ─── constants ────────────────────────────────────────────────────────────────
const COLORS: Record<string, any> = {
  hsd:        { badge: '#185FA5', text: '#0C447C', light: '#E6F1FB' },
  selenium:   { badge: '#3B6D11', text: '#27500A', light: '#EAF3DE' },
  playwright: { badge: '#854F0B', text: '#633806', light: '#FAEEDA' },
};
const STATUS_COLORS: Record<string, any> = {
  'In Progress': { bg: '#E6F1FB', text: '#185FA5' },
  'Planning':    { bg: '#FAEEDA', text: '#854F0B' },
  'Backlog':     { bg: '#F1EFE8', text: '#5F5E5A' },
  'Done':        { bg: '#EAF3DE', text: '#3B6D11' },
};
const IMPACT_COLORS: Record<string, any> = {
  High:   { bg: '#FCEBEB', text: '#A32D2D' },
  Medium: { bg: '#FAEEDA', text: '#854F0B' },
  Low:    { bg: '#F1EFE8', text: '#5F5E5A' },
};
const ROLE_COLORS: Record<string, any> = {
  admin:  { bg: '#FCEBEB', text: '#A32D2D' },
  editor: { bg: '#E6F1FB', text: '#185FA5' },
  viewer: { bg: '#F1EFE8', text: '#5F5E5A' },
};
const TOTAL_WEEKS = 14;
const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

const SEED_USERS = [
  { id: 1, name: 'Akhil',   username: 'akhil',   password: 'admin123', role: 'admin'  },
  { id: 2, name: 'Jacob',   username: 'jacob',   password: 'edit123',  role: 'editor' },
  { id: 3, name: 'Hruthik', username: 'hruthik', password: 'view123',  role: 'viewer' },
];

// ─── helpers ──────────────────────────────────────────────────────────────────
function addWeeks(d: Date, n: number): Date { return new Date(d.getTime() + n * MS_PER_WEEK); }
function startOfDay(d: Date): Date { const x = new Date(d); x.setHours(0,0,0,0); return x; }
function fmtShort(d: Date): string { return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); }
function fmtFull(d: Date): string  { return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); }
function initials(n: string): string { return n.trim().split(/\s+/).map((w: string) => w[0]).join('').slice(0, 2).toUpperCase(); }

function buildAxis(tools: any[]): any {
  const dated = tools.filter(t => t.w1Date);
  if (!dated.length) return null;
  const starts = dated.map(t => startOfDay(new Date(t.w1Date)));
  const ends   = dated.map(t => t.targetEndDate
    ? startOfDay(new Date(t.targetEndDate))
    : addWeeks(startOfDay(new Date(t.w1Date)), TOTAL_WEEKS - 1));
  const min = new Date(Math.min(...starts.map(d => d.getTime())));
  const max = new Date(Math.max(...ends.map(d => d.getTime())));
  return { minDate: min, totalCols: Math.ceil((max.getTime() - min.getTime() + MS_PER_WEEK) / MS_PER_WEEK) };
}

function toolPos(tool: any, axis: any): any {
  if (!tool.w1Date || !axis) return null;
  const w1 = startOfDay(new Date(tool.w1Date));
  return {
    leftPct:  ((w1.getTime() - axis.minDate.getTime()) / (axis.totalCols * MS_PER_WEEK)) * 100,
    widthPct: (TOTAL_WEEKS / axis.totalCols) * 100,
  };
}

function progress(tool: any): number {
  const all = tool.subtasks.length + tool.milestones.length;
  return all === 0 ? 0 : ((tool.subtasks.filter((s: any) => s.done).length + tool.milestones.filter((m: any) => m.done).length) / all) * 100;
}

// ─── small components ─────────────────────────────────────────────────────────
function Badge({ label, colors }: { label: string; colors: any }): React.ReactElement {
  return <span style={{ fontSize: 11, fontWeight: 500, padding: '2px 8px', borderRadius: 4, background: colors.bg, color: colors.text }}>{label}</span>;
}

function Avatar({ name, color, size = 24 }: { name: string; color: any; size?: number }): React.ReactElement {
  return (
    <div title={name} style={{ width: size, height: size, borderRadius: '50%', background: color.light, border: `1.5px solid ${color.badge}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: size * 0.38, fontWeight: 500, color: color.text, flexShrink: 0 }}>
      {initials(name)}
    </div>
  );
}

function ProgressRing({ pct, color }: { pct: number; color: any }): React.ReactElement {
  const r = 16, circ = 2 * Math.PI * r;
  return (
    <svg width={40} height={40} viewBox='0 0 40 40'>
      <circle cx={20} cy={20} r={r} fill='none' stroke='#e5e7eb' strokeWidth={4} />
      <circle cx={20} cy={20} r={r} fill='none' stroke={color.badge} strokeWidth={4}
        strokeDasharray={circ} strokeDashoffset={circ - (pct / 100) * circ}
        strokeLinecap='round' transform='rotate(-90 20 20)'
        style={{ transition: 'stroke-dashoffset 0.6s cubic-bezier(0.4,0,0.2,1)' }} />
      <text x={20} y={24} textAnchor='middle' fontSize={10} fontWeight={500} fill={color.text}>{Math.round(pct)}%</text>
    </svg>
  );
}

function RocketIcon({ color, size = 16 }: { color: string; size?: number }): React.ReactElement {
  return (
    <svg viewBox='0 0 24 24' width={size} height={size} fill='none' style={{ display: 'block' }}>
      <path d='M12 2C12 2 7 7 7 13a5 5 0 0010 0c0-6-5-11-5-11z' fill={color} opacity='0.9' />
      <path d='M9 13c0 1.66 1.34 3 3 3s3-1.34 3-3' fill='white' opacity='0.3' />
      <path d='M7 13c-1.5 0-3 1-3 3l3-1' fill={color} opacity='0.6' />
      <path d='M17 13c1.5 0 3 1 3 3l-3-1' fill={color} opacity='0.6' />
      <circle cx='12' cy='10' r='1.5' fill='white' opacity='0.8' />
      <path d='M10 19l2 3 2-3' fill={color} opacity='0.5' />
    </svg>
  );
}

function GanttBar({ tool, axis, color }: { tool: any; axis: any; color: any }): React.ReactElement {
  const pos   = toolPos(tool, axis);
  const today = startOfDay(new Date());
  const todayPct = axis ? ((today.getTime() - axis.minDate.getTime()) / (axis.totalCols * MS_PER_WEEK)) * 100 : null;
  const w1 = tool.w1Date ? startOfDay(new Date(tool.w1Date)) : null;
  return (
    <div style={{ position: 'relative', height: 36, background: '#f3f4f6', borderRadius: 6, overflow: 'visible' }}>
      {axis && Array.from({ length: axis.totalCols + 1 }, (_, i) => (
        <div key={i} style={{ position: 'absolute', left: `${(i / axis.totalCols) * 100}%`, top: 0, bottom: 0, width: '0.5px', background: '#d1d5db' }} />
      ))}
      {axis && todayPct !== null && todayPct >= 0 && todayPct <= 100 && (
        <div style={{ position: 'absolute', left: `${todayPct}%`, top: -6, bottom: -6, width: 2, background: '#D85A30', borderRadius: 2, zIndex: 4 }}>
          <div style={{ position: 'absolute', top: -14, left: '50%', transform: 'translateX(-50%)', fontSize: 9, fontWeight: 500, color: '#D85A30', whiteSpace: 'nowrap', background: 'white', padding: '1px 4px', borderRadius: 3, border: '0.5px solid #D85A30' }}>Today</div>
        </div>
      )}
      {pos && (() => {
        let w = pos.widthPct;
        if (tool.targetEndDate && w1) {
          const ep = ((startOfDay(new Date(tool.targetEndDate)).getTime() - axis.minDate.getTime()) / (axis.totalCols * MS_PER_WEEK)) * 100;
          w = Math.min(pos.widthPct, Math.max(0, ep - pos.leftPct));
        }
        const rl = Math.max(0, Math.min(pos.leftPct + w - 2, 98));
        return (
          <>
            <div style={{ position: 'absolute', left: `${pos.leftPct}%`, width: `${w}%`, top: '50%', transform: 'translateY(-50%)', height: 6, background: color.badge, opacity: 0.25, borderRadius: 3 }} />
            <div style={{ position: 'absolute', left: `${rl}%`, top: '50%', transform: 'translateY(-65%) rotate(-45deg)', zIndex: 5, animation: 'rocketFloat 0.6s ease-in-out infinite alternate', filter: `drop-shadow(0 0 3px ${color.badge}88)` }}>
              <RocketIcon color={color.badge} size={16} />
            </div>
          </>
        );
      })()}
      {axis && tool.targetEndDate && (() => {
        const ed = startOfDay(new Date(tool.targetEndDate));
        const ep = ((ed.getTime() - axis.minDate.getTime()) / (axis.totalCols * MS_PER_WEEK)) * 100;
        const ov = ed < today && tool.status !== 'Done';
        if (ep < 0 || ep > 100) return null;
        return (
          <div style={{ position: 'absolute', left: `calc(${ep}% - 1px)`, top: -6, bottom: -6, width: 2, background: ov ? '#A32D2D' : '#1D9E75', borderRadius: 2, zIndex: 3 }}>
            <div style={{ position: 'absolute', bottom: -14, left: '50%', transform: 'translateX(-50%)', fontSize: 9, fontWeight: 500, color: ov ? '#A32D2D' : '#1D9E75', whiteSpace: 'nowrap', background: 'white', padding: '1px 4px', borderRadius: 3, border: `0.5px solid ${ov ? '#A32D2D' : '#1D9E75'}` }}>
              {ov ? 'Overdue' : 'Target'}
            </div>
          </div>
        );
      })()}
      {pos && w1 && <div title={`W1: ${fmtFull(w1)}`} style={{ position: 'absolute', left: `calc(${pos.leftPct}% - 5px)`, top: '50%', transform: 'translateY(-50%)', width: 10, height: 10, borderRadius: 2, background: color.badge, zIndex: 3 }} />}
      {axis && tool.milestones.map((m: any) => {
        const md = m.targetDate ? startOfDay(new Date(m.targetDate)) : w1 ? addWeeks(w1, m.week - 1) : null;
        if (!md) return null;
        const mp = ((md.getTime() - axis.minDate.getTime()) / (axis.totalCols * MS_PER_WEEK)) * 100;
        if (mp < 0 || mp > 100) return null;
        return m.done ? (
          <div key={m.id} title={`${m.label} ✓`} style={{ position: 'absolute', left: `calc(${mp}% - 8px)`, top: '50%', transform: 'translateY(-80%) rotate(-45deg)', zIndex: 2, animation: 'rocketFloat 0.8s ease-in-out infinite alternate' }}>
            <RocketIcon color={color.badge} size={16} />
          </div>
        ) : (
          <div key={m.id} title={`${m.label} (${fmtShort(md)})`} style={{ position: 'absolute', left: `calc(${mp}% - 6px)`, top: '50%', transform: 'translateY(-50%)', width: 12, height: 12, borderRadius: 3, background: 'white', border: `2px solid ${color.badge}`, zIndex: 2 }} />
        );
      })}
      {!tool.w1Date && <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', paddingLeft: 10, fontSize: 11, color: '#9ca3af', fontStyle: 'italic' }}>Set W1 date to place on timeline</div>}
    </div>
  );
}

// ─── login screen ─────────────────────────────────────────────────────────────
function LoginScreen({ users, onLogin }: { users: any[]; onLogin: (u: any) => void }): React.ReactElement {
  const [un, setUn] = useState('');
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  function attempt(): void {
    const u = users.find(x => x.username === un.trim().toLowerCase() && x.password === pw);
    if (u) { setErr(''); onLogin(u); } else setErr('Incorrect username or password.');
  }
  return (
    <div style={{ minHeight: 420, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'inherit' }}>
      <div style={{ width: 340, background: 'white', border: '0.5px solid #e5e7eb', borderRadius: 12, padding: 28 }}>
        <div style={{ fontSize: 11, fontWeight: 500, color: '#6b7280', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 6 }}>Health Portfolio</div>
        <div style={{ fontSize: 18, fontWeight: 500, marginBottom: 4 }}>AI Tools Roadmap</div>
        <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 24 }}>Sign in to continue</div>
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4 }}>Username</div>
          <input value={un} onChange={e => setUn(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') attempt(); }} placeholder='e.g. akhil' style={{ fontSize: 13, width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '0.5px solid #d1d5db', borderRadius: 6 }} />
        </div>
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4 }}>Password</div>
          <input type='password' value={pw} onChange={e => setPw(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') attempt(); }} placeholder='••••••••' style={{ fontSize: 13, width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '0.5px solid #d1d5db', borderRadius: 6 }} />
        </div>
        {err && <div style={{ fontSize: 12, color: '#A32D2D', marginBottom: 12 }}>{err}</div>}
        <button onClick={attempt} style={{ width: '100%', fontSize: 13, padding: '8px 0', background: '#185FA5', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer' }}>Sign in</button>
      </div>
    </div>
  );
}

// ─── user panel ───────────────────────────────────────────────────────────────
function UserPanel({ users, setUsers, onClose }: { users: any[]; setUsers: any; onClose: () => void }): React.ReactElement {
  const [nn, setNn] = useState(''); const [nu, setNu] = useState(''); const [np, setNp] = useState(''); const [nr, setNr] = useState('viewer'); const [err, setErr] = useState('');
  function add(): void {
    if (!nn.trim() || !nu.trim() || !np.trim()) { setErr('All fields required.'); return; }
    if (users.find(u => u.username === nu.trim().toLowerCase())) { setErr('Username taken.'); return; }
    setUsers((u: any[]) => [...u, { id: Date.now(), name: nn.trim(), username: nu.trim().toLowerCase(), password: np, role: nr }]);
    setNn(''); setNu(''); setNp(''); setErr('');
  }
  return (
    <div style={{ background: 'white', border: '0.5px solid #e5e7eb', borderRadius: 12, padding: 20, marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ fontSize: 15, fontWeight: 500 }}>Manage users</div>
        <button onClick={onClose} style={{ fontSize: 12, padding: '3px 10px', cursor: 'pointer' }}>Close</button>
      </div>
      {users.map(u => (
        <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '0.5px solid #e5e7eb' }}>
          <Avatar name={u.name} color={{ light: ROLE_COLORS[u.role].bg, badge: ROLE_COLORS[u.role].text, text: ROLE_COLORS[u.role].text }} size={28} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 500 }}>{u.name}</div>
            <div style={{ fontSize: 11, color: '#6b7280' }}>@{u.username}</div>
          </div>
          <select value={u.role} onChange={e => { const r = e.target.value; setUsers((us: any[]) => us.map(x => x.id === u.id ? { ...x, role: r } : x)); }} style={{ fontSize: 12 }}>
            {['admin','editor','viewer'].map(r => <option key={r} value={r}>{r}</option>)}
          </select>
          <button onClick={() => setUsers((us: any[]) => us.filter(x => x.id !== u.id))} style={{ fontSize: 11, padding: '2px 8px', color: '#A32D2D', border: '0.5px solid #A32D2D', background: 'transparent', borderRadius: 4, cursor: 'pointer' }}>Remove</button>
        </div>
      ))}
      <div style={{ marginTop: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 10 }}>Add new user</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
          {([['Full name', nn, setNn, 'Michael'], ['Username', nu, setNu, 'michael'], ['Password', np, setNp, '••••••']] as any[]).map(([lbl, val, set, ph]) => (
            <div key={lbl}>
              <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4 }}>{lbl}</div>
              <input value={val} onChange={(e: React.ChangeEvent<HTMLInputElement>) => set(e.target.value)} placeholder={ph} style={{ fontSize: 12, width: '100%', boxSizing: 'border-box', padding: '6px 8px', border: '0.5px solid #d1d5db', borderRadius: 6 }} />
            </div>
          ))}
          <div>
            <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4 }}>Role</div>
            <select value={nr} onChange={e => setNr(e.target.value)} style={{ fontSize: 12, width: '100%', padding: '6px 8px', border: '0.5px solid #d1d5db', borderRadius: 6 }}>
              {['admin','editor','viewer'].map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
        </div>
        {err && <div style={{ fontSize: 12, color: '#A32D2D', marginBottom: 8 }}>{err}</div>}
        <button onClick={add} style={{ fontSize: 12, padding: '6px 16px', background: '#185FA5', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer' }}>Add user</button>
      </div>
    </div>
  );
}

// ─── main component ───────────────────────────────────────────────────────────
const AIToolsRoadmap: React.FC<IAIToolsRoadmapProps> = () => {
  const [loading,     setLoading]    = useState(true);
  const [spError,     setSpError]    = useState<string | null>(null);
  const [syncing,     setSyncing]    = useState(false);
  const [users,       setUsers]      = useState<any[]>(SEED_USERS);
  const [currentUser, setCurrentUser]= useState<any>(null);
  const [tools,       setTools]      = useState<any[]>([]);
  const [expanded,    setExpanded]   = useState<any>(null);
  const [activeTab,   setActiveTab]  = useState('roadmap');
  const [editTool,    setEditTool]   = useState<any>(null);
  const [editData,    setEditData]   = useState<any>({});
  const [newTool,     setNewTool]    = useState(false);
  const [newToolName, setNewToolName]= useState('');
  const [newToolDesc, setNewToolDesc]= useState('');
  const [ownerInput,  setOwnerInput] = useState<Record<string,string>>({});
  const [showUsers,   setShowUsers]  = useState(false);

  useEffect(() => {
    if (document.getElementById('gantt-anim')) return;
    const s = document.createElement('style');
    s.id = 'gantt-anim';
    s.textContent = '@keyframes rocketFloat { from { transform: translateY(-65%) rotate(-45deg); } to { transform: translateY(-90%) rotate(-45deg); } }';
    document.head.appendChild(s);
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadFromSP()
      .then(spTools => { if (!cancelled && spTools.length) setTools(spTools); })
      .catch(e => { if (!cancelled) setSpError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const axis = useMemo(() => buildAxis(tools), [tools]);
  const axisLabels = useMemo(() => {
    if (!axis) return [];
    return Array.from({ length: axis.totalCols }, (_: any, i: number) => ({ label: fmtShort(addWeeks(axis.minDate, i)), pct: (i / axis.totalCols) * 100 }));
  }, [axis]);

  const isAdmin  = currentUser?.role === 'admin';
  const canEdit  = currentUser?.role === 'editor' || isAdmin;
  const canAdmin = isAdmin;

  function syncToolFields(tool: any): void {
    setSyncing(true);
    const fields = { name: tool.name, category: tool.category, status: tool.status, impact: tool.impact, description: tool.description, owners: tool.owners.join(', '), notes: tool.notes || '', w1Date: tool.w1Date || null, targetEndDate: tool.targetEndDate || null, flaggedProgressWeek: tool.flaggedProgressWeek || null };
    const p = tool._spId
      ? updateItem('RoadmapTools', tool._spId, fields)
      : createItem('RoadmapTools', fields).then(c => { setTools(ts => ts.map(x => x.id === tool.id ? { ...x, _spId: c._id, id: c._id } : x)); });
    p.catch(e => setSpError(e.message)).finally(() => setSyncing(false));
  }

  function upField(id: any, f: string, v: any): void {
    setTools(ts => ts.map(x => x.id === id ? { ...x, [f]: v } : x));
    const tool = tools.find(x => x.id === id);
    if (tool) syncToolFields({ ...tool, [f]: v });
  }

  function togSubtask(tid: any, sid: any): void {
    setTools(ts => ts.map(x => x.id === tid ? { ...x, subtasks: x.subtasks.map((s: any) => s.id === sid ? { ...s, done: !s.done } : s) } : x));
    const tool = tools.find(x => x.id === tid);
    const sub  = tool?.subtasks.find((s: any) => s.id === sid);
    if (!sub) return;
    const p = sub._spId
      ? updateItem('RoadmapSubtasks', sub._spId, { tool_name: tool.name, label: sub.label, done: !sub.done })
      : createItem('RoadmapSubtasks', { tool_name: tool.name, label: sub.label, done: !sub.done }).then((c: any) => { setTools(ts => ts.map(x => x.id === tid ? { ...x, subtasks: x.subtasks.map((s: any) => s.id === sid ? { ...s, _spId: c._id, id: c._id } : s) } : x)); });
    p.catch((e: any) => setSpError(e.message));
  }

  function togMilestone(tid: any, mid: any): void {
    setTools(ts => ts.map(x => x.id === tid ? { ...x, milestones: x.milestones.map((m: any) => m.id === mid ? { ...m, done: !m.done } : m) } : x));
    const tool = tools.find(x => x.id === tid);
    const mil  = tool?.milestones.find((m: any) => m.id === mid);
    if (!mil) return;
    const p = mil._spId
      ? updateItem('RoadmapMilestones', mil._spId, { tool_name: tool.name, label: mil.label, week: mil.week, done: !mil.done, targetDate: mil.targetDate || null })
      : createItem('RoadmapMilestones', { tool_name: tool.name, label: mil.label, week: mil.week, done: !mil.done }).then((c: any) => { setTools(ts => ts.map(x => x.id === tid ? { ...x, milestones: x.milestones.map((m: any) => m.id === mid ? { ...m, _spId: c._id, id: c._id } : m) } : x)); });
    p.catch((e: any) => setSpError(e.message));
  }

  function addMilestone(tid: any): void {
    const tool = tools.find(x => x.id === tid);
    createItem('RoadmapMilestones', { tool_name: tool.name, label: '', week: 1, done: false })
      .then((c: any) => { setTools(ts => ts.map(x => x.id === tid ? { ...x, milestones: [...x.milestones, { id: c._id, _spId: c._id, label: '', week: 1, done: false, targetDate: null }] } : x)); })
      .catch((e: any) => setSpError(e.message));
  }

  function upMilestone(tid: any, mid: any, f: string, v: any): void {
    setTools(ts => ts.map(x => x.id === tid ? { ...x, milestones: x.milestones.map((m: any) => m.id === mid ? { ...m, [f]: v } : m) } : x));
    const tool = tools.find(x => x.id === tid);
    const mil  = tool?.milestones.find((m: any) => m.id === mid);
    if (mil?._spId) updateItem('RoadmapMilestones', mil._spId, { [f]: v }).catch((e: any) => setSpError(e.message));
  }

  function delMilestone(tid: any, mid: any): void {
    const tool = tools.find(x => x.id === tid);
    const mil  = tool?.milestones.find((m: any) => m.id === mid);
    setTools(ts => ts.map(x => x.id === tid ? { ...x, milestones: x.milestones.filter((m: any) => m.id !== mid) } : x));
    if (mil?._spId) deleteItem('RoadmapMilestones', mil._spId).catch((e: any) => setSpError(e.message));
  }

  function addOwner(tid: any): void {
    const name = (ownerInput[tid] || '').trim();
    if (!name) return;
    const tool = tools.find(x => x.id === tid);
    if (!tool || tool.owners.includes(name)) return;
    const updated = { ...tool, owners: [...tool.owners, name] };
    setTools(ts => ts.map(x => x.id === tid ? updated : x));
    setOwnerInput(o => ({ ...o, [tid]: '' }));
    syncToolFields(updated);
  }

  function removeOwner(tid: any, name: string): void {
    const tool = tools.find(x => x.id === tid);
    const updated = { ...tool, owners: tool.owners.filter((o: string) => o !== name) };
    setTools(ts => ts.map(x => x.id === tid ? updated : x));
    syncToolFields(updated);
  }

  function startEdit(tool: any, e: React.MouseEvent): void {
    e.stopPropagation();
    setEditData({ name: tool.name, description: tool.description, status: tool.status, impact: tool.impact, notes: tool.notes });
    setEditTool(tool.id);
  }

  function saveEdit(id: any): void {
    setTools(ts => ts.map(x => x.id === id ? { ...x, ...editData } : x));
    setEditTool(null);
    const tool = tools.find(x => x.id === id);
    if (tool) syncToolFields({ ...tool, ...editData });
  }

  function deleteTool(id: any, e: React.MouseEvent): void {
    e.stopPropagation();
    const tool = tools.find(x => x.id === id);
    setTools(ts => ts.filter(x => x.id !== id));
    if (expanded === id) setExpanded(null);
    if (!tool) return;
    if (tool._spId) deleteItem('RoadmapTools', tool._spId).catch((e2: any) => setSpError(e2.message));
    tool.milestones.forEach((m: any) => { if (m._spId) deleteItem('RoadmapMilestones', m._spId).catch(() => {}); });
    tool.subtasks.forEach((s: any) => { if (s._spId) deleteItem('RoadmapSubtasks', s._spId).catch(() => {}); });
  }

  function getCurWeek(tool: any): number | null {
    if (!tool.w1Date) return null;
    const d = Math.floor((startOfDay(new Date()).getTime() - startOfDay(new Date(tool.w1Date)).getTime()) / MS_PER_WEEK);
    return d < 0 ? null : Math.min(d + 1, TOTAL_WEEKS);
  }

  function flagProgress(tid: any): void {
    const cw = getCurWeek(tools.find(t => t.id === tid));
    if (cw) upField(tid, 'flaggedProgressWeek', cw);
  }

  function addToolFn(): void {
    if (!newToolName.trim()) return;
    createItem('RoadmapTools', { name: newToolName, category: 'hsd', status: 'Backlog', impact: 'Medium', description: newToolDesc, owners: '', notes: '' })
      .then((c: any) => { setTools(ts => [...ts, { id: c._id, _spId: c._id, name: newToolName, category: 'hsd', status: 'Backlog', impact: 'Medium', owners: [], description: newToolDesc, w1Date: null, targetEndDate: null, flaggedProgressWeek: null, milestones: [], subtasks: [], notes: '' }]); })
      .catch((e: any) => setSpError(e.message));
    setNewTool(false); setNewToolName(''); setNewToolDesc('');
  }

  const avgProgress = tools.length ? Math.round(tools.reduce((a, t) => a + progress(t), 0) / tools.length) : 0;

  if (loading) return (
    <div style={{ minHeight: 300, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, fontFamily: 'inherit', color: '#6b7280' }}>
      <div style={{ fontSize: 28 }}>🚀</div>
      <div style={{ fontSize: 13 }}>Connecting to SharePoint…</div>
    </div>
  );

  if (!currentUser) return <LoginScreen users={users} onLogin={u => setCurrentUser(u)} />;

  return (
    <div style={{ fontFamily: 'inherit', color: '#111827', padding: '1.5rem' }}>
      {showUsers && canAdmin && <UserPanel users={users} setUsers={setUsers} onClose={() => setShowUsers(false)} />}
      {spError && (
        <div style={{ marginBottom: 12, padding: '10px 14px', background: '#FCEBEB', borderRadius: 8, fontSize: 12, color: '#A32D2D', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>SharePoint error: {spError}</span>
          <button onClick={() => setSpError(null)} style={{ fontSize: 11, padding: '2px 8px', color: '#A32D2D', border: '0.5px solid #A32D2D', background: 'transparent', cursor: 'pointer', borderRadius: 4 }}>Dismiss</button>
        </div>
      )}
      {syncing && <div style={{ marginBottom: 8, padding: '6px 14px', background: '#EAF3DE', borderRadius: 8, fontSize: 12, color: '#27500A' }}>Syncing to SharePoint…</div>}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 500, color: '#6b7280', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 4 }}>Health Portfolio</div>
          <div style={{ fontSize: 20, fontWeight: 500 }}>AI Tools Roadmap</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {['roadmap','overview'].map(tab => (
            <button key={tab} onClick={() => setActiveTab(tab)} style={{ padding: '6px 14px', fontSize: 13, borderRadius: 8, background: activeTab === tab ? '#f3f4f6' : 'transparent', border: `0.5px solid ${activeTab === tab ? '#9ca3af' : '#e5e7eb'}`, cursor: 'pointer', fontWeight: activeTab === tab ? 500 : 400 }}>
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Avatar name={currentUser.name} color={{ light: ROLE_COLORS[currentUser.role].bg, badge: ROLE_COLORS[currentUser.role].text, text: ROLE_COLORS[currentUser.role].text }} size={28} />
            <div>
              <div style={{ fontSize: 12, fontWeight: 500 }}>{currentUser.name}</div>
              <Badge label={currentUser.role} colors={ROLE_COLORS[currentUser.role]} />
            </div>
          </div>
          {canAdmin && <button onClick={() => setShowUsers(true)} style={{ fontSize: 12, padding: '4px 12px', border: '0.5px solid #e5e7eb', borderRadius: 6, cursor: 'pointer' }}>Manage users</button>}
          <button onClick={() => setCurrentUser(null)} style={{ fontSize: 12, padding: '4px 12px', border: '0.5px solid #e5e7eb', borderRadius: 6, cursor: 'pointer' }}>Sign out</button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: 10, marginBottom: '1.5rem' }}>
        {[{ label: 'Total tools', value: tools.length }, { label: 'In progress', value: tools.filter(t => t.status === 'In Progress').length }, { label: 'High impact', value: tools.filter(t => t.impact === 'High').length }, { label: 'Avg. progress', value: `${avgProgress}%` }].map(m => (
          <div key={m.label} style={{ background: '#f9fafb', borderRadius: 8, padding: '12px 14px' }}>
            <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>{m.label}</div>
            <div style={{ fontSize: 22, fontWeight: 500 }}>{m.value}</div>
          </div>
        ))}
      </div>

      {activeTab === 'roadmap' && (
        <div style={{ marginBottom: '1.5rem' }}>
          {!axis ? (
            <div style={{ fontSize: 13, color: '#6b7280', padding: 16, background: '#f9fafb', borderRadius: 8, textAlign: 'center' }}>Set a W1 start date on at least one tool to see the calendar timeline.</div>
          ) : (
            <div>
              <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 8, marginBottom: 4 }}>
                <div />
                <div style={{ position: 'relative', height: 20 }}>
                  {axisLabels.filter((_: any, i: number) => i % 2 === 0).map((item: any) => (
                    <div key={item.label} style={{ position: 'absolute', left: `${item.pct}%`, fontSize: 10, color: '#9ca3af', transform: 'translateX(-50%)', whiteSpace: 'nowrap' }}>{item.label}</div>
                  ))}
                </div>
              </div>
              {tools.map(tool => {
                const c = COLORS[tool.category] || COLORS.hsd;
                const cw = getCurWeek(tool);
                return (
                  <div key={tool.id} style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 500, color: c.text }}>{tool.name}</div>
                      {tool.owners.length > 0 && <div style={{ display: 'flex', gap: 3, marginTop: 3 }}>{tool.owners.map((o: string) => <Avatar key={o} name={o} color={c} size={18} />)}</div>}
                      {tool.w1Date ? <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 2 }}>W1: {fmtFull(new Date(tool.w1Date))}{cw ? ` · W${cw}` : ''}</div> : <div style={{ fontSize: 10, color: '#9ca3af', fontStyle: 'italic', marginTop: 2 }}>No start date</div>}
                    </div>
                    <GanttBar tool={tool} axis={axis} color={c} />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ fontSize: 14, fontWeight: 500, color: '#6b7280' }}>Tools</div>
        {!canEdit && <Badge label='Read-only view' colors={{ bg: '#F1EFE8', text: '#5F5E5A' }} />}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {tools.map(tool => {
          const c   = COLORS[tool.category] || COLORS.hsd;
          const pct = progress(tool);
          const isOpen = expanded === tool.id;
          const cw  = getCurWeek(tool);
          return (
            <div key={tool.id} style={{ background: 'white', border: '0.5px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
              {editTool === tool.id && canEdit ? (
                <div style={{ padding: 16 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 12 }}>Edit tool</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
                    <div style={{ gridColumn: '1/-1' }}>
                      <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4 }}>Name</div>
                      <input value={editData.name} onChange={e => setEditData((d: any) => ({ ...d, name: e.target.value }))} style={{ fontSize: 13, width: '100%', boxSizing: 'border-box', padding: '6px 8px', border: '0.5px solid #d1d5db', borderRadius: 6 }} />
                    </div>
                    <div style={{ gridColumn: '1/-1' }}>
                      <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4 }}>Description</div>
                      <textarea value={editData.description} onChange={e => setEditData((d: any) => ({ ...d, description: e.target.value }))} rows={2} style={{ fontSize: 13, width: '100%', resize: 'vertical', boxSizing: 'border-box', padding: '6px 8px', border: '0.5px solid #d1d5db', borderRadius: 6 }} />
                    </div>
                    {[['Status','status',['Backlog','Planning','In Progress','Done']],['Impact','impact',['High','Medium','Low']]].map(([lbl,key,opts]) => (
                      <div key={key as string}>
                        <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4 }}>{lbl}</div>
                        <select value={editData[key as string]} onChange={e => { const v = e.target.value; setEditData((d: any) => ({ ...d, [key as string]: v })); }} style={{ fontSize: 12, width: '100%', padding: '6px 8px', border: '0.5px solid #d1d5db', borderRadius: 6 }}>
                          {(opts as string[]).map(o => <option key={o}>{o}</option>)}
                        </select>
                      </div>
                    ))}
                    <div style={{ gridColumn: '1/-1' }}>
                      <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4 }}>Notes</div>
                      <input value={editData.notes} onChange={e => setEditData((d: any) => ({ ...d, notes: e.target.value }))} placeholder='Notes…' style={{ fontSize: 12, width: '100%', boxSizing: 'border-box', padding: '6px 8px', border: '0.5px solid #d1d5db', borderRadius: 6 }} />
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={() => saveEdit(tool.id)} style={{ fontSize: 12, padding: '6px 14px', background: '#185FA5', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer' }}>Save</button>
                    <button onClick={() => setEditTool(null)} style={{ fontSize: 12, padding: '6px 14px', border: '0.5px solid #d1d5db', borderRadius: 6, cursor: 'pointer' }}>Cancel</button>
                  </div>
                </div>
              ) : (
                <div onClick={() => setExpanded(expanded === tool.id ? null : tool.id)} style={{ padding: '14px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ width: 4, alignSelf: 'stretch', borderRadius: 4, background: c.badge, flexShrink: 0 }} />
                  <ProgressRing pct={pct} color={c} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                      <div style={{ fontWeight: 500, fontSize: 14 }}>{tool.name}</div>
                      {tool.owners.map((o: string, i: number) => (
                        <div key={o} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <Avatar name={o} color={c} size={20} />
                          <span style={{ fontSize: 11, color: '#6b7280' }}>{o}</span>
                          {i < tool.owners.length - 1 && <span style={{ fontSize: 10, color: '#d1d5db' }}>·</span>}
                        </div>
                      ))}
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <Badge label={tool.status} colors={STATUS_COLORS[tool.status] || STATUS_COLORS['Backlog']} />
                      <Badge label={`Impact: ${tool.impact}`} colors={IMPACT_COLORS[tool.impact] || IMPACT_COLORS['Low']} />
                      {tool.w1Date && <Badge label={`W1: ${fmtFull(new Date(tool.w1Date))}`} colors={{ bg: '#EEEDFE', text: '#3C3489' }} />}
                      {cw && <Badge label={`Now: W${cw}`} colors={{ bg: '#E6F1FB', text: '#185FA5' }} />}
                      {tool.targetEndDate && (() => { const e = startOfDay(new Date(tool.targetEndDate)); const ov = e < startOfDay(new Date()) && tool.status !== 'Done'; return <Badge label={`End: ${fmtFull(e)}`} colors={{ bg: ov ? '#FCEBEB' : '#E1F5EE', text: ov ? '#A32D2D' : '#0F6E56' }} />; })()}
                      {tool.flaggedProgressWeek && <Badge label={`Flagged @ W${tool.flaggedProgressWeek} · ${Math.round(pct)}%`} colors={{ bg: '#FAECE7', text: '#993C1D' }} />}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }} onClick={e => e.stopPropagation()}>
                    {canEdit  && <button onClick={e => startEdit(tool, e)} style={{ fontSize: 11, padding: '3px 10px', border: '0.5px solid #d1d5db', borderRadius: 4, cursor: 'pointer' }}>Edit</button>}
                    {canAdmin && <button onClick={e => deleteTool(tool.id, e)} style={{ fontSize: 11, padding: '3px 10px', color: '#A32D2D', border: '0.5px solid #A32D2D', background: 'transparent', borderRadius: 4, cursor: 'pointer' }}>Remove</button>}
                    <div style={{ fontSize: 14, color: '#9ca3af' }}>{isOpen ? '▲' : '▼'}</div>
                  </div>
                </div>
              )}

              {isOpen && editTool !== tool.id && (
                <div style={{ padding: '0 16px 16px', borderTop: '0.5px solid #e5e7eb' }}>
                  <p style={{ fontSize: 13, color: '#6b7280', margin: '12px 0' }}>{tool.description}</p>
                  <div style={{ marginBottom: 14, padding: 12, background: '#f9fafb', borderRadius: 8 }}>
                    <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 8 }}>Owners</div>
                    {tool.owners.length > 0 && (
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
                        {tool.owners.map((o: string) => (
                          <div key={o} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px 4px 6px', background: 'white', borderRadius: 20, border: '0.5px solid #e5e7eb' }}>
                            <Avatar name={o} color={c} size={20} />
                            <span style={{ fontSize: 12 }}>{o}</span>
                            {canEdit && <button onClick={() => removeOwner(tool.id, o)} style={{ fontSize: 10, padding: '0 4px', border: 'none', background: 'transparent', color: '#9ca3af', cursor: 'pointer' }}>✕</button>}
                          </div>
                        ))}
                      </div>
                    )}
                    {canEdit && (
                      <div style={{ display: 'flex', gap: 8 }}>
                        <input value={ownerInput[tool.id] || ''} onChange={e => { const v = e.target.value; setOwnerInput(o => ({ ...o, [tool.id]: v })); }} onKeyDown={e => { if (e.key === 'Enter') addOwner(tool.id); }} placeholder='Add owner name…' style={{ fontSize: 12, flex: 1, boxSizing: 'border-box', padding: '6px 8px', border: '0.5px solid #d1d5db', borderRadius: 6 }} />
                        <button onClick={() => addOwner(tool.id)} style={{ fontSize: 12, padding: '0 12px', background: '#185FA5', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer' }}>Add</button>
                      </div>
                    )}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 14, padding: 12, background: '#f9fafb', borderRadius: 8 }}>
                    <div>
                      <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 6 }}>W1 start date</div>
                      {canEdit ? <input type='date' value={tool.w1Date || ''} onChange={e => upField(tool.id, 'w1Date', e.target.value)} style={{ fontSize: 12, width: '100%', boxSizing: 'border-box', padding: '5px 6px', border: '0.5px solid #d1d5db', borderRadius: 6 }} /> : <div style={{ fontSize: 13 }}>{tool.w1Date ? fmtFull(new Date(tool.w1Date)) : '—'}</div>}
                      {tool.w1Date && <div style={{ fontSize: 11, color: '#6b7280', marginTop: 6 }}>{cw ? `W${cw} of ${TOTAL_WEEKS}` : 'Not started'}</div>}
                    </div>
                    <div>
                      <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 6 }}>Target end date</div>
                      {canEdit ? <input type='date' value={tool.targetEndDate || ''} min={tool.w1Date || ''} onChange={e => upField(tool.id, 'targetEndDate', e.target.value)} style={{ fontSize: 12, width: '100%', boxSizing: 'border-box', padding: '5px 6px', border: '0.5px solid #d1d5db', borderRadius: 6 }} /> : <div style={{ fontSize: 13 }}>{tool.targetEndDate ? fmtFull(new Date(tool.targetEndDate)) : '—'}</div>}
                      {tool.targetEndDate && tool.w1Date && (() => { const dl = Math.ceil((startOfDay(new Date(tool.targetEndDate)).getTime() - startOfDay(new Date()).getTime()) / (24*60*60*1000)); const ov = dl < 0 && tool.status !== 'Done'; return <div style={{ fontSize: 11, marginTop: 6, color: ov ? '#A32D2D' : '#6b7280', fontWeight: ov ? 500 : 400 }}>{ov ? `Overdue by ${Math.abs(dl)}d` : tool.status === 'Done' ? 'Completed' : `${dl}d remaining`}</div>; })()}
                    </div>
                    <div>
                      <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 6 }}>Progress snapshot</div>
                      {canEdit && <button onClick={() => flagProgress(tool.id)} disabled={!tool.w1Date} style={{ fontSize: 12, padding: '6px 12px', width: '100%', cursor: tool.w1Date ? 'pointer' : 'not-allowed', opacity: tool.w1Date ? 1 : 0.45, background: '#185FA5', color: 'white', border: 'none', borderRadius: 6 }}>Flag as today</button>}
                      <div style={{ fontSize: 11, color: '#6b7280', marginTop: 6 }}>{tool.flaggedProgressWeek ? `W${tool.flaggedProgressWeek} — ${Math.round(pct)}%` : tool.w1Date ? 'Not flagged' : 'Set W1 to enable'}</div>
                    </div>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 14 }}>
                    {[['Status','status',['Backlog','Planning','In Progress','Done']],['Impact','impact',['High','Medium','Low']]].map(([lbl,key,opts]) => (
                      <div key={key as string}>
                        <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4 }}>{lbl}</div>
                        {canEdit ? <select value={tool[key as string]} onChange={e => upField(tool.id, key as string, e.target.value)} style={{ fontSize: 12, width: '100%', padding: '5px 6px', border: '0.5px solid #d1d5db', borderRadius: 6 }}>{(opts as string[]).map(o => <option key={o}>{o}</option>)}</select> : <Badge label={tool[key as string]} colors={(key==='status' ? STATUS_COLORS : IMPACT_COLORS)[tool[key as string]] || STATUS_COLORS['Backlog']} />}
                      </div>
                    ))}
                    <div>
                      <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4 }}>Progress</div>
                      <div style={{ fontSize: 13, fontWeight: 500 }}>{Math.round(pct)}%</div>
                    </div>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 12 }}>
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 8 }}>Milestones</div>
                      {tool.milestones.map((m: any) => {
                        const dd = tool.w1Date ? fmtShort(addWeeks(startOfDay(new Date(tool.w1Date)), m.week - 1)) : null;
                        return (
                          <div key={m.id} style={{ marginBottom: 10, padding: '8px 10px', background: '#f9fafb', borderRadius: 8 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                              <input type='checkbox' checked={m.done} onChange={() => { if (canEdit) togMilestone(tool.id, m.id); }} disabled={!canEdit} style={{ cursor: canEdit ? 'pointer' : 'default', flexShrink: 0 }} />
                              {canEdit ? <input value={m.label} onChange={e => upMilestone(tool.id, m.id, 'label', e.target.value)} placeholder='Milestone label…' style={{ fontSize: 12, flex: 1, minWidth: 0, textDecoration: m.done ? 'line-through' : 'none', padding: '4px 6px', border: '0.5px solid #d1d5db', borderRadius: 4 }} /> : <span style={{ fontSize: 12, flex: 1, textDecoration: m.done ? 'line-through' : 'none', color: m.done ? '#9ca3af' : '#111827' }}>{m.label || 'Untitled'}</span>}
                              {canEdit && <button onClick={() => delMilestone(tool.id, m.id)} style={{ fontSize: 10, padding: '1px 6px', color: '#A32D2D', border: '0.5px solid #A32D2D', background: 'transparent', borderRadius: 4, cursor: 'pointer', flexShrink: 0 }}>✕</button>}
                            </div>
                            {canEdit && (
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 24 }}>
                                <div style={{ fontSize: 10, color: '#6b7280', flexShrink: 0 }}>Target date</div>
                                <input type='date' value={m.targetDate || ''} min={tool.w1Date || ''} max={tool.targetEndDate || ''} onChange={e => upMilestone(tool.id, m.id, 'targetDate', e.target.value)} style={{ fontSize: 11, flex: 1, padding: '3px 5px', border: '0.5px solid #d1d5db', borderRadius: 4 }} />
                                {dd && !m.targetDate && <div style={{ fontSize: 10, color: '#9ca3af', whiteSpace: 'nowrap' }}>~{dd}</div>}
                              </div>
                            )}
                            {!canEdit && m.targetDate && <div style={{ fontSize: 11, color: '#6b7280', paddingLeft: 24, marginTop: 4 }}>{fmtFull(new Date(m.targetDate))}</div>}
                          </div>
                        );
                      })}
                      {canEdit && <button onClick={() => addMilestone(tool.id)} style={{ fontSize: 11, padding: '4px 10px', width: '100%', borderStyle: 'dashed', borderColor: '#d1d5db', background: 'transparent', borderRadius: 6, cursor: 'pointer' }}>+ Add milestone</button>}
                    </div>
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 8 }}>Subtasks</div>
                      {tool.subtasks.map((s: any) => (
                        <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                          <input type='checkbox' checked={s.done} onChange={() => { if (canEdit) togSubtask(tool.id, s.id); }} disabled={!canEdit} style={{ cursor: canEdit ? 'pointer' : 'default' }} />
                          <span style={{ fontSize: 12, color: s.done ? '#9ca3af' : '#111827', textDecoration: s.done ? 'line-through' : 'none' }}>{s.label}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4 }}>Notes</div>
                    {canEdit ? <textarea value={tool.notes} onChange={e => upField(tool.id, 'notes', e.target.value)} placeholder='Add notes, overlap risks, links…' rows={2} style={{ width: '100%', fontSize: 12, resize: 'vertical', boxSizing: 'border-box', padding: '6px 8px', border: '0.5px solid #d1d5db', borderRadius: 6 }} /> : <div style={{ fontSize: 12, color: tool.notes ? '#111827' : '#9ca3af', fontStyle: tool.notes ? 'normal' : 'italic' }}>{tool.notes || 'No notes added.'}</div>}
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {canAdmin && (
          newTool ? (
            <div style={{ background: 'white', border: '0.5px solid #e5e7eb', borderRadius: 12, padding: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 10 }}>New tool</div>
              <input value={newToolName} onChange={e => setNewToolName(e.target.value)} placeholder='Tool name…' style={{ fontSize: 13, width: '100%', marginBottom: 8, boxSizing: 'border-box', padding: '7px 9px', border: '0.5px solid #d1d5db', borderRadius: 6 }} />
              <input value={newToolDesc} onChange={e => setNewToolDesc(e.target.value)} placeholder='Short description…' style={{ fontSize: 13, width: '100%', marginBottom: 12, boxSizing: 'border-box', padding: '7px 9px', border: '0.5px solid #d1d5db', borderRadius: 6 }} />
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={addToolFn} style={{ fontSize: 12, padding: '6px 14px', background: '#185FA5', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer' }}>Add tool</button>
                <button onClick={() => setNewTool(false)} style={{ fontSize: 12, padding: '6px 14px', border: '0.5px solid #d1d5db', borderRadius: 6, cursor: 'pointer' }}>Cancel</button>
              </div>
            </div>
          ) : (
            <button onClick={() => setNewTool(true)} style={{ fontSize: 13, padding: '10px 0', borderRadius: 12, width: '100%', borderStyle: 'dashed', borderColor: '#d1d5db', background: 'transparent', cursor: 'pointer' }}>+ Add tool</button>
          )
        )}
      </div>
    </div>
  );
};

export default AIToolsRoadmap;