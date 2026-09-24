import { useEffect, useState, type FormEvent } from 'react';
import { BookOpen, CalendarDays, Check, ChevronLeft, ChevronRight, Clock3, ExternalLink, GraduationCap, KeyRound, LockKeyhole, Map, MessageSquareText, Pause, Play, Plus, QrCode, RotateCcw, School, Timer, Trash2, UnlockKeyhole, X } from 'lucide-react';
import { connectCampus, connectOffice, disconnectCampus, disconnectOffice, fetchAcademicClasses, fetchAcademicExams, fetchBuildings, fetchCampuses, fetchEntryCode, fetchForumBanners, fetchForumPosts, fetchOfficeCaptcha, fetchRoomSchedule, fetchRooms, type CampusClasses, type CampusCredentials, type CampusSession, type StudyroomItem } from '../lib/campus-api';
import { forgetCampusCredentials, hasCampusCredentials, storeCampusCredentials, unlockCampusCredentials } from '../lib/campus-vault';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import './campus-tools.css';

export const campusToolList = [
  { id: 'schedule', name: '课程表', Icon: CalendarDays },
  { id: 'entry', name: '入校码', Icon: QrCode },
  { id: 'map', name: '校园地图', Icon: Map },
  { id: 'calendar', name: '学校校历', Icon: BookOpen },
  { id: 'gpa', name: 'GPA', Icon: GraduationCap },
  { id: 'rooms', name: '空教室', Icon: School },
  { id: 'forum', name: '论坛', Icon: MessageSquareText },
  { id: 'focus', name: '番茄时钟', Icon: Timer },
] as const;
export type CampusToolId = typeof campusToolList[number]['id'];

type Course = { id: string; name: string; place: string; day: number; start: number; end: number; color: number };
type Grade = { id: string; name: string; credits: number; points: number };
type CampusData = { courses: Course[]; grades: Grade[] };
type FocusState = { duration: number; remaining: number; endsAt: number | null; sessions: number };
type LiveRooms = { campuses: StudyroomItem[]; buildings: StudyroomItem[]; rooms: StudyroomItem[] };
const weekDays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const defaultFocus: FocusState = { duration: 25, remaining: 25 * 60, endsAt: null, sessions: 0 };

function load<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) ?? '') as T; } catch { return fallback; }
}

function External({ href, children }: { href: string; children: React.ReactNode }) {
  return <a className="campus-external" href={href} target="_blank" rel="noopener noreferrer">{children}<ExternalLink size={15} /></a>;
}

function CredentialVault({ identity, open, onOpenChange, onUnlock, onLock }: { identity: string; open: boolean; onOpenChange: (open: boolean) => void; onUnlock: (credentials: CampusCredentials) => void; onLock: () => void }) {
  const [exists, setExists] = useState(() => hasCampusCredentials(identity));
  const [editing, setEditing] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [officeUsername, setOfficeUsername] = useState('');
  const [officePassword, setOfficePassword] = useState('');

  function openBinding() {
    setMessage('');
    setEditing(!exists);
    onOpenChange(true);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setMessage('');
    try {
      await storeCampusCredentials(identity, passphrase, {
        wpyUsername: username.trim(),
        wpyPassword: password,
        officeUsername: officeUsername.trim(),
        officePassword,
      });
      setExists(true); setEditing(false); setUnlocked(true);
      setPassphrase('');
      onOpenChange(false);
      onUnlock({
        wpyUsername: username.trim(),
        wpyPassword: password,
        officeUsername: officeUsername.trim(),
        officePassword,
      });
      setMessage('已绑定并加密保存在当前设备。');
    } catch (error) { setMessage(error instanceof Error ? error.message : '保存失败。'); }
    finally { setBusy(false); }
  }

  async function unlock(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setMessage('');
    try {
      const credentials = await unlockCampusCredentials(identity, passphrase);
      setUsername(credentials.wpyUsername);
      setPassword(credentials.wpyPassword);
      setOfficeUsername(credentials.officeUsername);
      setOfficePassword(credentials.officePassword);
      setUnlocked(true);
      onUnlock(credentials);
      setPassphrase('');
      onOpenChange(false);
      setMessage('已解锁，正在连接微北洋实时服务。');
    } catch { setMessage('解锁失败：口令错误或本地数据已损坏。'); }
    finally { setBusy(false); }
  }

  function lock() {
    setUsername(''); setPassword(''); setOfficeUsername(''); setOfficePassword(''); setPassphrase('');
    setUnlocked(false); setEditing(false); setMessage('');
    onLock();
  }

  return <>
    <section className="campus-vault" aria-label="本地校园账号保险箱">
      <div className="campus-section-head"><KeyRound size={17} /><h2>校园账号</h2><span>{unlocked ? '已连接' : exists ? '已绑定' : '未绑定'}</span></div>
      <p>微北洋账号与办公网账号分别绑定。账号只在请求服务时解密到内存，本地仅保存 AES-GCM 密文。</p>
      {unlocked ? <div className="campus-vault-unlocked"><span>微北洋 {username} · 办公网 {officeUsername}</span><button type="button" onClick={lock}><LockKeyhole size={15} /> 锁定</button></div> : <button type="button" className="campus-vault-primary" onClick={openBinding}>{exists ? '解锁已绑定账号' : '绑定微北洋与办公网账号'}</button>}
      {message ? <p className="campus-vault-message" role="status">{message}</p> : null}
    </section>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="campus-credential-dialog">
        <header className="campus-dialog-header"><div><DialogTitle>{editing ? '绑定校园账号' : '解锁校园账号'}</DialogTitle><DialogDescription>{editing ? '微北洋和办公网是两套独立账号，请分别填写。' : '输入本设备的独立解锁口令，恢复实时校园服务。'}</DialogDescription></div><DialogClose asChild><button type="button" className="campus-dialog-close" aria-label="关闭绑定窗口"><X size={17} /></button></DialogClose></header>
        <div className="campus-dialog-body">
          {editing ? <form className="campus-form" onSubmit={save}>
            <fieldset><legend>微北洋账号</legend><label>微北洋账号<input autoComplete="off" value={username} onChange={event => setUsername(event.target.value)} required /></label><label>微北洋密码<input type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} required /></label></fieldset>
            <fieldset><legend>办公网账号</legend><label>办公网账号<input autoComplete="off" value={officeUsername} onChange={event => setOfficeUsername(event.target.value)} required /></label><label>办公网密码<input type="password" autoComplete="new-password" value={officePassword} onChange={event => setOfficePassword(event.target.value)} required /></label></fieldset>
            <label>本地独立解锁口令（至少 12 位）<input type="password" autoComplete="new-password" minLength={12} value={passphrase} onChange={event => setPassphrase(event.target.value)} required /></label>
            <div className="campus-form-actions"><button type="submit" disabled={busy}><LockKeyhole size={15} /> 绑定并加密保存</button><button type="button" onClick={() => onOpenChange(false)}>取消</button></div>
          </form> : <form className="campus-vault-unlock campus-dialog-unlock" onSubmit={unlock}>
            <label htmlFor="campus-unlock">本地独立解锁口令<input id="campus-unlock" type="password" autoComplete="off" placeholder="输入独立解锁口令" value={passphrase} onChange={event => setPassphrase(event.target.value)} /></label>
            <div className="campus-form-actions"><button type="submit" disabled={busy || !passphrase}><UnlockKeyhole size={15} /> 解锁并继续</button><button type="button" onClick={() => setEditing(true)}>更换绑定</button></div>
          </form>}
          {message ? <p className="campus-vault-message" role="status">{message}</p> : null}
          {exists ? <button type="button" className="campus-delete-credentials" onClick={() => { if (!window.confirm('删除这台设备上的加密校园账号？')) return; try { forgetCampusCredentials(identity); setExists(false); setEditing(true); setUsername(''); setPassword(''); setOfficeUsername(''); setOfficePassword(''); setPassphrase(''); onLock(); } catch { setMessage('本地存储不可用，未能删除。'); } }}><Trash2 size={14} /> 删除本地绑定</button> : null}
        </div>
      </DialogContent>
    </Dialog>
  </>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(item => item && typeof item === 'object') as Record<string, unknown>[] : [];
}

function rawArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function numberValue(value: unknown, fallback: number): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function firstText(row: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return '';
}

function liveCourses(classes: CampusClasses | null): Course[] {
  if (!classes) return [];
  const source = asRecord(classes.courses);
  const rows = [...asArray(source.major), ...asArray(source.minor)];
  return rows.flatMap((row, rowIndex) => {
    const arrangements = asArray(row.arrangeList);
    return arrangements.map((arrangement, arrangementIndex) => {
      const item = asRecord(arrangement);
      const unitList = rawArray(item.unitList).map(value => numberValue(value, 1));
      const start = Math.max(1, Math.round(unitList[0] ?? 1));
      const end = Math.max(start, Math.round(unitList[1] ?? start));
      return {
        id: `live-${rowIndex}-${arrangementIndex}`,
        name: String(item.name || row.name || '未命名课程'),
        place: String(item.location || row.campus || ''),
        day: Math.max(0, Math.min(6, numberValue(item.weekday, 1) - 1)),
        start,
        end,
        color: rowIndex % 4,
      };
    });
  });
}

function liveGrades(classes: CampusClasses | null): Grade[] {
  if (!classes) return [];
  const gpa = asRecord(classes.gpa);
  const rows = asArray(gpa.courses);
  return rows.map((row, index) => ({
    id: `live-grade-${index}`,
    name: String(row.name || '未命名课程'),
    credits: numberValue(row.credit, 0),
    points: numberValue(row.gpa, 0),
  })).filter(item => item.credits > 0);
}

function campusErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'body' in error) {
    const id = ((error as { body?: { error?: { id?: string } } }).body?.error?.id) ?? '';
    if (id === 'campus_invalid_credentials' || id === 'campus_office_credentials_invalid') return '校园账号或办公网账号不正确。';
    if (id === 'campus_not_configured') return '服务端尚未配置微北洋上游凭据。';
    if (id === 'campus_session_required' || id === 'campus_session_expired') return '微北洋连接已过期，请重新解锁账号。';
  }
  return '微北洋服务暂时不可用，请稍后重试。';
}

export function CampusTools({ identity, activeId }: { identity: string; activeId: CampusToolId }) {
  const dataKey = `tjuclaw.campus.data.v1.${identity}`;
  const focusKey = `tjuclaw.campus.focus.v1.${identity}`;
  const [data, setData] = useState<CampusData>(() => load(dataKey, { courses: [], grades: [] }));
  const [focus, setFocus] = useState<FocusState>(() => load(focusKey, defaultFocus));
  const [now, setNow] = useState(0);
  const [weekOffset, setWeekOffset] = useState(0);
  const [course, setCourse] = useState({ name: '', place: '', day: 0, start: 1, end: 2 });
  const [grade, setGrade] = useState({ name: '', credits: '', points: '' });
  const [campusSession, setCampusSession] = useState<CampusSession | null>(null);
  const [liveClasses, setLiveClasses] = useState<CampusClasses | null>(null);
  const [liveExams, setLiveExams] = useState<Record<string, unknown>[]>([]);
  const [entryCode, setEntryCode] = useState<{ content: string; expires_at: string } | null>(null);
  const [rooms, setRooms] = useState<LiveRooms>({ campuses: [], buildings: [], rooms: [] });
  const [selectedCampus, setSelectedCampus] = useState<number | null>(null);
  const [selectedBuilding, setSelectedBuilding] = useState<number | null>(null);
  const [selectedRoom, setSelectedRoom] = useState<number | null>(null);
  const [roomSchedule, setRoomSchedule] = useState<Record<string, unknown>[]>([]);
  const [forum, setForum] = useState<{ banners?: Record<string, unknown>; posts?: Record<string, unknown> }>({});
  const [liveError, setLiveError] = useState('');
  const [credentialDialogOpen, setCredentialDialogOpen] = useState(false);
  const tool = campusToolList.find(item => item.id === activeId) ?? campusToolList[0];
  const Icon = tool.Icon;
  const needsCampusBinding = activeId === 'schedule' || activeId === 'entry' || activeId === 'gpa' || activeId === 'rooms' || activeId === 'forum';
  const schoolCourses = liveCourses(liveClasses);
  const schoolGrades = liveGrades(liveClasses);
  const visibleCourses = schoolCourses.length ? schoolCourses : data.courses;
  const visibleGrades = schoolGrades.length ? schoolGrades : data.grades;

  async function unlockLiveCampus(next: CampusCredentials) {
    setLiveError('');
    try {
      const session = await connectCampus(next);
      setCampusSession(session);
      const captcha = await fetchOfficeCaptcha();
      const code = window.prompt('请输入办公网验证码');
      if (!code?.trim()) {
        setLiveError('需要完成办公网验证码后才能读取教务数据。');
        return;
      }
      await connectOffice(next, captcha.captcha_id, code.trim());
      const classes = await fetchAcademicClasses();
      setLiveClasses(classes);
      try { setLiveExams((await fetchAcademicExams()).exams.filter(item => item && typeof item === 'object') as Record<string, unknown>[]); } catch { setLiveExams([]); }
    } catch (error) {
      setLiveError(campusErrorMessage(error));
    }
  }

  function lockLiveCampus() {
    setCampusSession(null);
    setLiveClasses(null);
    setLiveExams([]);
    setEntryCode(null);
    setRooms({ campuses: [], buildings: [], rooms: [] });
    setSelectedRoom(null);
    setRoomSchedule([]);
    void disconnectCampus().catch(() => undefined);
    void disconnectOffice().catch(() => undefined);
  }

  async function refreshEntryCode() {
    setLiveError('');
    try { setEntryCode(await fetchEntryCode()); } catch (error) { setLiveError(campusErrorMessage(error)); }
  }

  async function loadCampuses() {
    setLiveError('');
    try {
      const result = await fetchCampuses();
      setRooms(current => ({ ...current, campuses: result.data }));
    } catch (error) { setLiveError(campusErrorMessage(error)); }
  }

  async function loadBuildings(campusId: number) {
    setSelectedCampus(campusId);
    setSelectedBuilding(null);
    setRooms(current => ({ ...current, buildings: [], rooms: [] }));
    try {
      const result = await fetchBuildings(campusId);
      setRooms(current => ({ ...current, buildings: result.data }));
    } catch (error) { setLiveError(campusErrorMessage(error)); }
  }

  async function loadRooms(buildingId: number) {
    setSelectedBuilding(buildingId);
    setSelectedRoom(null);
    setRoomSchedule([]);
    try {
      const result = await fetchRooms(buildingId, -1, new Date().toISOString().slice(0, 10));
      setRooms(current => ({ ...current, rooms: result.data }));
    } catch (error) { setLiveError(campusErrorMessage(error)); }
  }

  async function loadRoomSchedule(roomId: number) {
    setSelectedRoom(roomId);
    try {
      const result = await fetchRoomSchedule(roomId);
      setRoomSchedule(result.data.filter(item => item && typeof item === 'object') as Record<string, unknown>[]);
    } catch (error) { setLiveError(campusErrorMessage(error)); }
  }

  async function loadForum() {
    setLiveError('');
    try {
      const [banners, posts] = await Promise.all([fetchForumBanners(), fetchForumPosts()]);
      setForum({ banners: banners.data, posts: posts.data });
    } catch (error) { setLiveError(campusErrorMessage(error)); }
  }

  useEffect(() => { try { localStorage.setItem(dataKey, JSON.stringify(data)); } catch { /* Device-local tools stay usable without persistence. */ } }, [dataKey, data]);
  useEffect(() => { try { localStorage.setItem(focusKey, JSON.stringify(focus)); } catch { /* Device-local tools stay usable without persistence. */ } }, [focusKey, focus]);
  useEffect(() => {
    if (!focus.endsAt) return;
    const tick = () => {
      const currentTime = Date.now();
      setNow(currentTime);
      setFocus(current => current.endsAt && currentTime >= current.endsAt
        ? { ...current, endsAt: null, remaining: 0, sessions: current.sessions + 1 } : current);
    };
    const interval = window.setInterval(tick, 1000);
    const initial = window.setTimeout(tick, 0);
    const visibility = () => { if (document.visibilityState === 'visible') tick(); };
    document.addEventListener('visibilitychange', visibility);
    return () => { window.clearTimeout(initial); window.clearInterval(interval); document.removeEventListener('visibilitychange', visibility); };
  }, [focus.endsAt]);

  function addCourse(event: FormEvent) {
    event.preventDefault();
    if (!course.name.trim()) return;
    setData(current => ({ ...current, courses: [...current.courses, { ...course, id: crypto.randomUUID(), name: course.name.trim(), place: course.place.trim(), end: Math.max(course.start, course.end), color: current.courses.length % 4 }] }));
    setCourse(current => ({ ...current, name: '', place: '' }));
  }

  function addGrade(event: FormEvent) {
    event.preventDefault();
    const credits = Number(grade.credits), points = Number(grade.points);
    if (!grade.name.trim() || !Number.isFinite(credits) || credits <= 0 || !Number.isFinite(points) || points < 0 || points > 4) return;
    setData(current => ({ ...current, grades: [...current.grades, { id: crypto.randomUUID(), name: grade.name.trim(), credits, points }] }));
    setGrade({ name: '', credits: '', points: '' });
  }

  const monday = new Date();
  monday.setDate(monday.getDate() - (monday.getDay() + 6) % 7 + weekOffset * 7);
  const totalCredits = visibleGrades.reduce((sum, item) => sum + item.credits, 0);
  const average = totalCredits ? visibleGrades.reduce((sum, item) => sum + item.credits * item.points, 0) / totalCredits : 0;
  const remaining = Math.max(0, focus.endsAt && now ? Math.ceil((focus.endsAt - now) / 1000) : focus.remaining);
  const focusLabel = `${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`;

  return <section className={`campus-tool campus-tool-${activeId}`} aria-label={`${tool.name}小工具`}>
    <header className="campus-tool-header"><span className="campus-tool-icon"><Icon size={20} /></span><div><h1>{tool.name}</h1><p>{campusSession ? `已连接微北洋 · ${campusSession.user_number || campusSession.nickname || '当前账号'}` : activeId === 'schedule' || activeId === 'gpa' || activeId === 'focus' ? '仅保存在当前设备 · 解锁后可同步校园数据' : '校园服务与资料'}</p></div></header>
    {liveError ? <p className="campus-live-error" role="alert">{liveError}</p> : null}
    {activeId === 'schedule' ? <>
      <div className="campus-schedule-nav"><button type="button" onClick={() => setWeekOffset(value => value - 1)} aria-label="上一周"><ChevronLeft size={17} /></button><strong>{monday.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })} 起 · {weekOffset === 0 ? '本周' : weekOffset > 0 ? `${weekOffset} 周后` : `${-weekOffset} 周前`}</strong><button type="button" onClick={() => setWeekOffset(value => value + 1)} aria-label="下一周"><ChevronRight size={17} /></button><button type="button" onClick={() => setWeekOffset(0)} disabled={weekOffset === 0}>今天</button></div>
      <div className="campus-schedule-scroll"><div className="campus-week"><div className="campus-week-corner">节次</div>{weekDays.map((day, index) => <div className="campus-week-day" key={day}>{day}<small>{new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + index).getDate()}</small></div>)}
        {Array.from({ length: 12 }, (_, index) => <div className="campus-week-row" key={index}><span>{index + 1}</span>{weekDays.map((day, dayIndex) => {
          const item = visibleCourses.find(candidate => candidate.day === dayIndex && candidate.start === index + 1);
          const occupied = visibleCourses.some(candidate => candidate.day === dayIndex && candidate.start < index + 1 && candidate.end >= index + 1);
          return <div className="campus-week-cell" key={day}>{item ? <div className={`campus-class color-${item.color}`} style={{ minHeight: `${Math.max(1, item.end - item.start + 1) * 45 - 3}px` }} title={`${item.name} · ${item.place}`}><strong>{item.name}</strong><small>{item.place || `${item.start}–${item.end} 节`}</small></div> : occupied ? null : null}</div>;
        })}</div>)}</div></div>
      <form className="campus-form campus-inline-form" onSubmit={addCourse}><h2>添加课程</h2><div className="campus-form-grid"><label>课程名<input value={course.name} onChange={event => setCourse({ ...course, name: event.target.value })} placeholder="例如：高等数学" required /></label><label>地点<input value={course.place} onChange={event => setCourse({ ...course, place: event.target.value })} placeholder="教室（可选）" /></label><label>星期<select value={course.day} onChange={event => setCourse({ ...course, day: Number(event.target.value) })}>{weekDays.map((day, index) => <option key={day} value={index}>{day}</option>)}</select></label><label>开始节次<input type="number" min="1" max="12" value={course.start} onChange={event => setCourse({ ...course, start: Number(event.target.value) })} /></label><label>结束节次<input type="number" min={course.start} max="12" value={course.end} onChange={event => setCourse({ ...course, end: Number(event.target.value) })} /></label></div><button type="submit"><Plus size={15} /> 添加到课表</button></form>
      {data.courses.length ? <div className="campus-course-list">{data.courses.map(item => <div key={item.id}><span><strong>{item.name}</strong><small>{weekDays[item.day]} · {item.start}–{item.end} 节 · {item.place || '未填写教室'}</small></span><button type="button" aria-label={`删除课程 ${item.name}`} onClick={() => setData(current => ({ ...current, courses: current.courses.filter(courseItem => courseItem.id !== item.id) }))}><Trash2 size={15} /></button></div>)}</div> : null}
      <p className="campus-footnote">{schoolCourses.length ? '已按微北洋教务数据显示当前课表；切换周次时仍按课程周规则展示。' : '手动课表按每周重复显示；绑定账号后可从微北洋同步。'}{!campusSession ? <button type="button" className="campus-inline-action" onClick={() => setCredentialDialogOpen(true)}>同步微北洋</button> : null}</p>
      {liveExams.length ? <section className="campus-exam-list"><h2>近期考试</h2>{liveExams.map((exam, index) => <div key={String(exam.id ?? index)}><strong>{firstText(exam, ['name', 'course_name', 'courseName', 'course']) || '未命名考试'}</strong><span>{[firstText(exam, ['date', 'exam_date', 'examDate']), firstText(exam, ['time', 'exam_time', 'examTime']), firstText(exam, ['location', 'place', 'room'])].filter(Boolean).join(' · ') || '考试安排待补充'}</span></div>)}</section> : null}
    </> : null}
    {activeId === 'entry' ? <div className="campus-entry-message"><QrCode size={33} /><div><h2>入校码需要实时认证</h2><p>微北洋实时入校码由校园 CAS 签发，有效期约 3 分钟，不会写入本地存储。</p>{entryCode ? <div className="campus-entry-code">{/^data:image|^https?:\/\//.test(entryCode.content) ? <img src={entryCode.content} alt="实时入校码" /> : <code>{entryCode.content}</code>}<small>有效至 {new Date(entryCode.expires_at).toLocaleTimeString('zh-CN')}</small></div> : null}<button type="button" className="campus-action-button" onClick={() => campusSession ? void refreshEntryCode() : setCredentialDialogOpen(true)}><QrCode size={15} /> {entryCode ? '刷新入校码' : campusSession ? '获取入校码' : '绑定账号后获取'}</button></div></div> : null}
    {activeId === 'map' ? <><div className="campus-map-index"><div><img src="/campus/map/wjl-thumb.jpeg" alt="卫津路校区地图" /><Map size={27} /><h2>卫津路校区</h2><p>南开区卫津路 92 号</p><a className="campus-external" href="/campus/map/wjl.png" target="_blank" rel="noopener noreferrer">查看高清地图<ExternalLink size={15} /></a></div><div><img src="/campus/map/byy-thumb.jpeg" alt="北洋园校区地图" /><School size={27} /><h2>北洋园校区</h2><p>津南区雅观路 135 号</p><a className="campus-external" href="/campus/map/byy.png" target="_blank" rel="noopener noreferrer">查看高清地图<ExternalLink size={15} /></a></div></div><p className="campus-footnote">地图资源随微北洋客户端分发；校内道路和楼宇如有调整，以学校公告为准。</p></> : null}
    {activeId === 'calendar' ? <div className="campus-calendar-sheet"><CalendarDays size={27} /><h2>学校校历</h2><p>显示微北洋随包发布的校历资料。教学安排调整时，请以天津大学教务处正式通知为准。</p><div className="campus-calendar-images"><a href="/campus/calendar/first.jpg" target="_blank" rel="noopener noreferrer"><img src="/campus/calendar/first-thumb.jpg" alt="学校校历上半页" /></a><a href="/campus/calendar/second.jpg" target="_blank" rel="noopener noreferrer"><img src="/campus/calendar/second-thumb.jpg" alt="学校校历下半页" /></a></div><External href="https://oaa.tju.edu.cn/">打开天津大学教务处</External></div> : null}
    {activeId === 'gpa' ? <><div className="campus-gpa-result"><span>{schoolGrades.length ? '微北洋教务 GPA' : '本地学分加权平均绩点'}</span><strong>{totalCredits ? average.toFixed(3) : '—'}</strong><small>{totalCredits ? `${totalCredits.toFixed(1)} 学分 · ${visibleGrades.length} 门课程` : '添加课程或绑定账号后开始计算'}</small></div><p className="campus-footnote">{schoolGrades.length ? '数据来自 learning.twt.edu.cn/get_classes 的 GPA 结果。' : '本地估算：Σ(课程绩点 × 学分) ÷ Σ学分。'}{!campusSession ? <button type="button" className="campus-inline-action" onClick={() => setCredentialDialogOpen(true)}>同步微北洋</button> : null}</p><form className="campus-form campus-inline-form" onSubmit={addGrade}><h2>录入课程绩点</h2><div className="campus-form-grid"><label>课程名<input value={grade.name} onChange={event => setGrade({ ...grade, name: event.target.value })} placeholder="课程名" required /></label><label>学分<input type="number" min=".1" step=".1" value={grade.credits} onChange={event => setGrade({ ...grade, credits: event.target.value })} required /></label><label>绩点（0–4）<input type="number" min="0" max="4" step=".01" value={grade.points} onChange={event => setGrade({ ...grade, points: event.target.value })} required /></label></div><button type="submit"><Plus size={15} /> 计入平均</button></form><div className="campus-grade-list">{data.grades.map(item => <div key={item.id}><span>{item.name}</span><span>{item.credits} 学分</span><strong>{item.points.toFixed(2)}</strong><button type="button" aria-label={`删除成绩 ${item.name}`} onClick={() => setData(current => ({ ...current, grades: current.grades.filter(gradeItem => gradeItem.id !== item.id) }))}><Trash2 size={15} /></button></div>)}</div></> : null}
    {activeId === 'rooms' ? <div className="campus-service-sheet"><Clock3 size={28} /><h2>微北洋空教室</h2><p>按校区、楼宇和当前时段读取自习室实时占用状态。</p>{campusSession ? <><div className="campus-live-actions"><button type="button" className="campus-action-button" onClick={() => void loadCampuses()}>读取校区</button>{rooms.campuses.map(item => <button type="button" className="campus-choice-button" key={String(item.id)} onClick={() => void loadBuildings(Number(item.id))}>{String(item.name || item.id)}</button>)}</div>{selectedCampus !== null ? <div className="campus-live-actions">{rooms.buildings.map(item => <button type="button" className="campus-choice-button" key={String(item.id)} onClick={() => void loadRooms(Number(item.id))}>{String(item.name || item.id)}</button>)}</div> : null}{selectedBuilding !== null ? <div className="campus-room-list">{rooms.rooms.map(item => <button type="button" className="campus-room-row" key={String(item.id)} onClick={() => item.id !== undefined && void loadRoomSchedule(item.id)}><strong>{String(item.name || item.id)}</strong><span>{item.free ? '空闲' : '使用中'}</span></button>)}</div> : null}{selectedRoom !== null && roomSchedule.length ? <pre className="campus-live-json">{JSON.stringify(roomSchedule, null, 2)}</pre> : null}</> : <><p className="campus-footnote">空教室需要实时校园数据。</p><button type="button" className="campus-action-button" onClick={() => setCredentialDialogOpen(true)}>绑定账号后读取</button></>}</div> : null}
    {activeId === 'forum' ? <div className="campus-forum-sheet"><MessageSquareText size={28} /><h2>青年湖底</h2><p>帖子和活动横幅来自微北洋论坛实时接口。</p>{campusSession ? <button type="button" className="campus-action-button" onClick={() => void loadForum()}>刷新论坛</button> : <><p className="campus-footnote">论坛需要连接微北洋账号。</p><button type="button" className="campus-action-button" onClick={() => setCredentialDialogOpen(true)}>绑定账号后查看</button></>}{forum.posts ? <pre className="campus-live-json">{JSON.stringify(forum.posts, null, 2)}</pre> : null}</div> : null}
    {activeId === 'focus' ? <div className="campus-focus"><div className="campus-focus-clock" role="timer" aria-label={`剩余 ${focusLabel}`}><span>{focusLabel}</span><small>{focus.endsAt ? '专注中' : remaining === 0 ? '完成一次专注' : '准备开始'}</small></div><div className="campus-focus-actions"><button type="button" onClick={() => { setNow(Date.now()); setFocus(current => current.endsAt ? { ...current, endsAt: null, remaining: Math.max(0, Math.ceil((current.endsAt - Date.now()) / 1000)) } : { ...current, endsAt: Date.now() + current.remaining * 1000 }); }} disabled={remaining === 0}>{focus.endsAt ? <Pause size={16} /> : <Play size={16} />}{focus.endsAt ? '暂停' : '开始专注'}</button><button type="button" onClick={() => setFocus(current => ({ ...current, endsAt: null, remaining: current.duration * 60 }))}><RotateCcw size={16} /> 重置</button></div><div className="campus-focus-presets" aria-label="专注时长">{[15, 25, 45, 60].map(minutes => <button type="button" key={minutes} aria-pressed={focus.duration === minutes} onClick={() => setFocus(current => ({ ...current, duration: minutes, remaining: minutes * 60, endsAt: null }))}>{focus.duration === minutes ? <Check size={14} /> : null}{minutes} 分钟</button>)}</div><p><strong>{focus.sessions}</strong> 次专注已完成 · 按实际时间计算，切换工具或锁屏后仍可恢复。</p></div> : null}
    {needsCampusBinding ? <CredentialVault identity={identity} open={credentialDialogOpen} onOpenChange={setCredentialDialogOpen} onUnlock={unlockLiveCampus} onLock={lockLiveCampus} /> : null}
  </section>;
}
