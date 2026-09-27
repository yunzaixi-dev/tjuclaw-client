import { useEffect, useRef, useState, type FormEvent } from 'react';
import { BookOpen, CalendarDays, Check, ChevronLeft, ChevronRight, Clock3, ExternalLink, GraduationCap, KeyRound, LockKeyhole, Map, MessageSquareText, Pause, Play, Plus, QrCode, RotateCcw, School, Timer, Trash2, UnlockKeyhole, X } from 'lucide-react';
import { connectCampus, connectOffice, disconnectCampus, disconnectOffice, fetchAcademicClasses, fetchAcademicExams, fetchAcademicGPA, fetchBuildings, fetchCampuses, fetchEntryCode, fetchForumPosts, fetchOfficeCaptcha, fetchRoomSchedule, fetchRooms, readOfficeSession, readSemester, type CampusClasses, type CampusCredentials, type CampusSemester, type CampusSession, type ForumPosts, type OfficeCaptcha, type StudyroomItem } from '../lib/campus-api';
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
const forumPageSize = 10;

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
  return Array.isArray(value) ? value.filter(item => item && typeof item === 'object' && !Array.isArray(item)) as Record<string, unknown>[] : [];
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

function localDate() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function roomScheduleDetails(row: Record<string, unknown>): string[] {
  const date = firstText(row, ['date', 'day']);
  const session = firstText(row, ['session', 'session_id', 'sessionId']);
  const time = firstText(row, ['time', 'start_time', 'startTime']);
  const end = firstText(row, ['end_time', 'endTime']);
  const status = typeof row.free === 'boolean' ? row.free ? '空闲' : '使用中' : firstText(row, ['status']);
  return [date, session ? `第 ${session} 节` : '', time && end ? `${time}–${end}` : time, status].filter(Boolean);
}

function parseForumPosts(value: unknown): ForumPosts {
  const data = asRecord(value);
  if (!Array.isArray(data.list) || !Number.isSafeInteger(data.total) || (data.total as number) < 0) {
    throw new Error('invalid forum posts');
  }
  const list = data.list.map((value: unknown) => {
    const row = asRecord(value);
    const id = row.id;
    if (!((typeof id === 'number' && Number.isSafeInteger(id) && id > 0) || (typeof id === 'string' && /^[1-9][0-9]*$/.test(id))) ||
        typeof row.title !== 'string' || typeof row.created_at !== 'string') {
      throw new Error('invalid forum posts');
    }
    return {
      id,
      title: row.title,
      created_at: row.created_at,
      comment_count: typeof row.comment_count === 'number' && row.comment_count >= 0 ? row.comment_count : undefined,
      like_count: typeof row.like_count === 'number' && row.like_count >= 0 ? row.like_count : undefined,
      tag: typeof asRecord(row.tag).name === 'string' ? { name: asRecord(row.tag).name as string } : null,
    };
  });
  return { list, total: data.total as number };
}

function liveCourses(classes: CampusClasses | null, teachingWeek: number | null): Course[] {
  if (!classes) return [];
  const source = asRecord(classes.courses);
  const rows = [...asArray(source.major), ...asArray(source.minor)];
  return rows.flatMap((row, rowIndex) => {
    const arrangements = asArray(row.arrangeList);
    return arrangements.flatMap((arrangement, arrangementIndex) => {
      const item = asRecord(arrangement);
      if (teachingWeek !== null && Array.isArray(item.weekList) &&
        !item.weekList.includes(teachingWeek)) return [];
      const unitList = rawArray(item.unitList).map(value => numberValue(value, 1));
      const start = Math.max(1, Math.round(unitList[0] ?? 1));
      const end = Math.max(start, Math.round(unitList[1] ?? start));
      return [{
        id: `live-${rowIndex}-${arrangementIndex}`,
        name: String(item.name || row.name || '未命名课程'),
        place: String(item.location || row.campus || ''),
        day: Math.max(0, Math.min(6, numberValue(item.weekday, 1) - 1)),
        start,
        end,
        color: rowIndex % 4,
      }];
    });
  });
}

function liveGrades(gpaData: Record<string, unknown> | null): Grade[] {
  const gpa = asRecord(gpaData);
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
    if (id === 'campus_invalid_credentials') return '微北洋账号或密码不正确。';
    if (id === 'campus_not_configured') return '服务端尚未配置微北洋上游凭据。';
    if (id === 'campus_session_required' || id === 'campus_session_expired') return '微北洋连接已过期，请重新解锁账号。';
    if (id === 'campus_office_captcha_expired') return '办公网验证码已过期，请刷新图片后重试。';
    if (id === 'campus_office_credentials_invalid') return '办公网账号、密码或验证码有误，请刷新验证码重试。';
    if (id === 'campus_office_session_required' || id === 'campus_office_session_expired') return '办公网连接已过期，请重新输入验证码。';
    if (id === 'campus_invalid_response' || id === 'campus_academic_unavailable') return '办公网教务数据暂时无法验证，请稍后重试。';
  }
  return '校园服务暂时不可用，请稍后重试。';
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
  const [semester, setSemester] = useState<CampusSemester | null>(null);
  const semesterRequest = useRef(0);
  const credentialsRef = useRef<CampusCredentials | null>(null);
  const [officeConnected, setOfficeConnected] = useState(false);
  const [officeDialogOpen, setOfficeDialogOpen] = useState(false);
  const [officeCaptcha, setOfficeCaptcha] = useState<OfficeCaptcha | null>(null);
  const [officeCode, setOfficeCode] = useState('');
  const [officeBusy, setOfficeBusy] = useState(false);
  const [officeError, setOfficeError] = useState('');
  const officeRequest = useRef(0);
  const [liveClasses, setLiveClasses] = useState<CampusClasses | null>(null);
  const [liveGPA, setLiveGPA] = useState<Record<string, unknown> | null>(null);
  const [liveExams, setLiveExams] = useState<Record<string, unknown>[]>([]);
  const [academicLoading, setAcademicLoading] = useState(false);
  const academicRequest = useRef(0);
  const [entryCode, setEntryCode] = useState<{ content: string; expires_at: string } | null>(null);
  const [rooms, setRooms] = useState<LiveRooms>({ campuses: [], buildings: [], rooms: [] });
  const [selectedCampus, setSelectedCampus] = useState<number | null>(null);
  const [selectedBuilding, setSelectedBuilding] = useState<number | null>(null);
  const [selectedRoom, setSelectedRoom] = useState<number | null>(null);
  const [roomSchedule, setRoomSchedule] = useState<Record<string, unknown>[]>([]);
  const [roomDate, setRoomDate] = useState(localDate);
  const [roomSession, setRoomSession] = useState(1);
  const [roomLoading, setRoomLoading] = useState(false);
  const [scheduleState, setScheduleState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const roomsRequest = useRef(0);
  const scheduleRequest = useRef(0);
  const [forum, setForum] = useState<{ page: number; posts: ForumPosts } | null>(null);
  const [forumLoading, setForumLoading] = useState(false);
  const forumRequest = useRef(0);
  const [liveError, setLiveError] = useState('');
  const [credentialDialogOpen, setCredentialDialogOpen] = useState(false);
  const tool = campusToolList.find(item => item.id === activeId) ?? campusToolList[0];
  const Icon = tool.Icon;
  const needsCampusBinding = activeId === 'schedule' || activeId === 'entry' || activeId === 'gpa' || activeId === 'rooms' || activeId === 'forum';
  const monday = new Date();
  monday.setDate(monday.getDate() - (monday.getDay() + 6) % 7 + weekOffset * 7);
  const termStart = semester?.semesterStartAt.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const termDay = termStart ? new Date(Number(termStart[1]), Number(termStart[2]) - 1, Number(termStart[3])) : null;
  if (termDay && (!Number.isFinite(termDay.getTime()) || termDay.getFullYear() !== Number(termStart?.[1]) ||
    termDay.getMonth() !== Number(termStart?.[2]) - 1 || termDay.getDate() !== Number(termStart?.[3]))) {
    // An invalid or rolled-over calendar date cannot anchor a teaching week.
    termDay.setTime(NaN);
  }
  if (termDay && Number.isFinite(termDay.getTime())) termDay.setDate(termDay.getDate() - (termDay.getDay() + 6) % 7);
  const teachingWeek = termDay && Number.isFinite(termDay.getTime())
    ? 1 + Math.round((Date.UTC(monday.getFullYear(), monday.getMonth(), monday.getDate()) -
      Date.UTC(termDay.getFullYear(), termDay.getMonth(), termDay.getDate())) / (7 * 24 * 60 * 60 * 1000))
    : null;
  const schoolCourses = liveCourses(liveClasses, teachingWeek);
  const schoolGrades = liveGrades(liveGPA ?? liveClasses?.gpa ?? null);
  const visibleCourses = [...schoolCourses, ...data.courses];
  const visibleGrades = schoolGrades.length ? schoolGrades : data.grades;

  async function loadOfficeCaptcha() {
    const request = ++officeRequest.current;
    setOfficeBusy(true);
    setOfficeError('');
    setOfficeCode('');
    setOfficeCaptcha(null);
    try {
      const captcha = await fetchOfficeCaptcha();
      if (request !== officeRequest.current) return;
      const contentType = (captcha.content_type ?? '').split(';')[0].trim();
      if (!/^image\/(?:png|jpeg|gif|webp)$/i.test(contentType) || !/^[A-Za-z0-9+/]+={0,2}$/.test(captcha.data) || !captcha.captcha_id) {
        throw new Error('invalid captcha image');
      }
      setOfficeCaptcha({ ...captcha, content_type: contentType });
    } catch (error) {
      if (request === officeRequest.current) setOfficeError(error instanceof Error && error.message === 'invalid captcha image' ? '办公网验证码图片无效，请刷新重试。' : campusErrorMessage(error));
    } finally { if (request === officeRequest.current) setOfficeBusy(false); }
  }

  async function unlockLiveCampus(next: CampusCredentials) {
    forumRequest.current++;
    academicRequest.current++;
    officeRequest.current++;
    const semesterGeneration = ++semesterRequest.current;
    setLiveError('');
    setForum(null);
    setForumLoading(false);
    credentialsRef.current = next;
    setCampusSession(null);
    setSemester(null);
    setOfficeConnected(false);
    setOfficeBusy(false);
    setOfficeError('');
    setOfficeCaptcha(null);
    setLiveClasses(null);
    setLiveGPA(null);
    setLiveExams([]);
    setAcademicLoading(false);
    setEntryCode(null);
    try {
      const session = await connectCampus(next);
      if (semesterGeneration !== semesterRequest.current) return;
      setCampusSession(session);
      void readSemester().then(result => {
        if (semesterGeneration === semesterRequest.current) setSemester(result.semester);
      }).catch(() => undefined);
      try {
        const office = await readOfficeSession();
        if (semesterGeneration !== semesterRequest.current) return;
        if (office.username === next.officeUsername.trim() && Date.parse(office.expires_at) > Date.now()) {
          setOfficeConnected(true);
          void loadAcademicData();
          return;
        }
      } catch { /* A missing or expired session needs a fresh captcha. */ }
      if (semesterGeneration !== semesterRequest.current) return;
      setOfficeDialogOpen(true);
      await loadOfficeCaptcha();
    } catch (error) {
      if (semesterGeneration !== semesterRequest.current) return;
      credentialsRef.current = null;
      setLiveError(campusErrorMessage(error));
    }
  }

  async function loadAcademicData() {
    const request = ++academicRequest.current;
    setAcademicLoading(true);
    setLiveError('');
    try {
      const classes = await fetchAcademicClasses();
      if (request !== academicRequest.current) return;
      setLiveClasses(classes);
      setLiveGPA(null);
      setLiveExams(asArray(classes.exams));
      try {
        const result = await fetchAcademicExams();
        if (request === academicRequest.current && Array.isArray(result.exams)) setLiveExams(asArray(result.exams));
      } catch { /* The classes response already includes exams. */ }
      try {
        const result = await fetchAcademicGPA();
        if (request === academicRequest.current && result.gpa && typeof result.gpa === 'object' && !Array.isArray(result.gpa)) setLiveGPA(result.gpa);
      } catch { /* The classes response already includes GPA. */ }
    } catch (error) {
      if (request !== academicRequest.current) return;
      setLiveClasses(null);
      setLiveGPA(null);
      setLiveExams([]);
      setLiveError(campusErrorMessage(error));
      const id = (error as { body?: { error?: { id?: string } } })?.body?.error?.id;
      if (id === 'campus_office_session_required' || id === 'campus_office_session_expired') {
        setOfficeConnected(false);
        setOfficeDialogOpen(true);
        void loadOfficeCaptcha();
      }
    }
    finally { if (request === academicRequest.current) setAcademicLoading(false); }
  }

  async function submitOfficeCode(event: FormEvent) {
    event.preventDefault();
    if (!officeCaptcha || !credentialsRef.current || !officeCode.trim() || officeBusy) return;
    const generation = semesterRequest.current;
    const request = ++officeRequest.current;
    setOfficeBusy(true);
    setOfficeError('');
    try {
      await connectOffice(credentialsRef.current, officeCaptcha.captcha_id, officeCode.trim());
      if (generation !== semesterRequest.current || request !== officeRequest.current) return;
      setOfficeConnected(true);
      setOfficeDialogOpen(false);
      setOfficeCaptcha(null);
      setOfficeCode('');
      void loadAcademicData();
    } catch (error) {
      if (generation === semesterRequest.current && request === officeRequest.current) {
        setOfficeError(campusErrorMessage(error));
        setOfficeCaptcha(null);
        setOfficeCode('');
      }
    } finally { if (generation === semesterRequest.current && request === officeRequest.current) setOfficeBusy(false); }
  }

  function lockLiveCampus() {
    forumRequest.current++;
    academicRequest.current++;
    roomsRequest.current++;
    scheduleRequest.current++;
    semesterRequest.current++;
    officeRequest.current++;
    credentialsRef.current = null;
    setCampusSession(null);
    setSemester(null);
    setOfficeConnected(false);
    setOfficeBusy(false);
    setOfficeError('');
    setOfficeDialogOpen(false);
    setOfficeCaptcha(null);
    setOfficeCode('');
    setLiveError('');
    setForum(null);
    setForumLoading(false);
    setLiveClasses(null);
    setLiveGPA(null);
    setLiveExams([]);
    setAcademicLoading(false);
    setEntryCode(null);
    setRooms({ campuses: [], buildings: [], rooms: [] });
    setSelectedRoom(null);
    setRoomSchedule([]);
    setRoomLoading(false);
    setScheduleState('idle');
    void disconnectCampus().catch(() => undefined);
    void disconnectOffice().catch(() => undefined);
  }

  async function refreshEntryCode() {
    setLiveError('');
    try { setEntryCode(await fetchEntryCode()); } catch (error) { setLiveError(campusErrorMessage(error)); }
  }

  async function loadCampuses() {
    const request = ++roomsRequest.current;
    scheduleRequest.current++;
    setLiveError('');
    setSelectedCampus(null);
    setSelectedBuilding(null);
    setSelectedRoom(null);
    setRoomSchedule([]);
    setScheduleState('idle');
    setRoomLoading(false);
    setRooms({ campuses: [], buildings: [], rooms: [] });
    try {
      const result = await fetchCampuses();
      if (request === roomsRequest.current) setRooms(current => ({ ...current, campuses: asArray(result.data) }));
    } catch (error) { if (request === roomsRequest.current) setLiveError(campusErrorMessage(error)); }
  }

  async function loadBuildings(campusId: number) {
    const request = ++roomsRequest.current;
    scheduleRequest.current++;
    setLiveError('');
    setSelectedCampus(campusId);
    setSelectedBuilding(null);
    setSelectedRoom(null);
    setRoomSchedule([]);
    setScheduleState('idle');
    setRooms(current => ({ ...current, buildings: [], rooms: [] }));
    try {
      const result = await fetchBuildings(campusId);
      if (request === roomsRequest.current) setRooms(current => ({ ...current, buildings: asArray(result.data) }));
    } catch (error) { if (request === roomsRequest.current) setLiveError(campusErrorMessage(error)); }
  }

  async function loadRooms(buildingId: number, date = roomDate, session = roomSession) {
    const request = ++roomsRequest.current;
    scheduleRequest.current++;
    setLiveError('');
    setSelectedBuilding(buildingId);
    setSelectedRoom(null);
    setRoomSchedule([]);
    setScheduleState('idle');
    setRoomLoading(true);
    setRooms(current => ({ ...current, rooms: [] }));
    if (!date) {
      setRoomLoading(false);
      return;
    }
    try {
      const result = await fetchRooms(buildingId, session, date);
      if (request === roomsRequest.current) setRooms(current => ({ ...current, rooms: asArray(result.data) }));
    } catch (error) { if (request === roomsRequest.current) setLiveError(campusErrorMessage(error)); }
    finally { if (request === roomsRequest.current) setRoomLoading(false); }
  }

  async function loadRoomSchedule(roomId: number) {
    const request = ++scheduleRequest.current;
    setLiveError('');
    setSelectedRoom(roomId);
    setRoomSchedule([]);
    setScheduleState('loading');
    try {
      const result = await fetchRoomSchedule(roomId);
      if (request === scheduleRequest.current) {
        setRoomSchedule(asArray(result.data));
        setScheduleState('ready');
      }
    } catch (error) {
      if (request === scheduleRequest.current) {
        setLiveError(campusErrorMessage(error));
        setScheduleState('error');
      }
    }
  }

  async function loadForum(page = 1) {
    const request = ++forumRequest.current;
    setForumLoading(true);
    setLiveError('');
    try {
      const result = await fetchForumPosts(page);
      const posts = parseForumPosts(result.data);
      if (request === forumRequest.current) setForum({ page, posts });
    } catch (error) {
      if (request === forumRequest.current) setLiveError(error instanceof Error && error.message === 'invalid forum posts' ? '论坛数据格式异常，请稍后重试。' : campusErrorMessage(error));
    } finally { if (request === forumRequest.current) setForumLoading(false); }
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

  const totalCredits = visibleGrades.reduce((sum, item) => sum + item.credits, 0);
  const average = totalCredits ? visibleGrades.reduce((sum, item) => sum + item.credits * item.points, 0) / totalCredits : 0;
  const remaining = Math.max(0, focus.endsAt && now ? Math.ceil((focus.endsAt - now) / 1000) : focus.remaining);
  const focusLabel = `${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`;

  return <section className={`campus-tool campus-tool-${activeId}`} aria-label={`${tool.name}小工具`}>
    <header className="campus-tool-header"><span className="campus-tool-icon"><Icon size={20} /></span><div><h1>{tool.name}</h1><p>{campusSession ? `已连接微北洋 · ${campusSession.user_number || campusSession.nickname || '当前账号'}` : activeId === 'schedule' || activeId === 'gpa' || activeId === 'focus' ? '仅保存在当前设备 · 解锁后可同步校园数据' : '校园服务与资料'}</p></div></header>
    {liveError ? <p className="campus-live-error" role="alert">{liveError}</p> : null}
    {activeId === 'schedule' ? <>
      <div className="campus-schedule-nav"><button type="button" onClick={() => setWeekOffset(value => value - 1)} aria-label="上一周"><ChevronLeft size={17} /></button><strong>{monday.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })} 起 · {teachingWeek !== null ? `${semester?.semesterName} · ${teachingWeek > 0 ? `第 ${teachingWeek} 教学周` : '学期开始前'}` : weekOffset === 0 ? '本周' : weekOffset > 0 ? `${weekOffset} 周后` : `${-weekOffset} 周前`}</strong><button type="button" onClick={() => setWeekOffset(value => value + 1)} aria-label="下一周"><ChevronRight size={17} /></button><button type="button" onClick={() => setWeekOffset(0)} disabled={weekOffset === 0}>今天</button></div>
      <div className="campus-schedule-scroll"><div className="campus-week"><div className="campus-week-corner">节次</div>{weekDays.map((day, index) => <div className="campus-week-day" key={day}>{day}<small>{new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + index).getDate()}</small></div>)}
        {Array.from({ length: 12 }, (_, index) => <div className="campus-week-row" key={index}><span>{index + 1}</span>{weekDays.map((day, dayIndex) => {
          const item = visibleCourses.find(candidate => candidate.day === dayIndex && candidate.start === index + 1);
          const occupied = visibleCourses.some(candidate => candidate.day === dayIndex && candidate.start < index + 1 && candidate.end >= index + 1);
          return <div className="campus-week-cell" key={day}>{item ? <div className={`campus-class color-${item.color}`} style={{ minHeight: `${Math.max(1, item.end - item.start + 1) * 45 - 3}px` }} title={`${item.name} · ${item.place}`}><strong>{item.name}</strong><small>{item.place || `${item.start}–${item.end} 节`}</small></div> : occupied ? null : null}</div>;
        })}</div>)}</div></div>
      <form className="campus-form campus-inline-form" onSubmit={addCourse}><h2>添加课程</h2><div className="campus-form-grid"><label>课程名<input value={course.name} onChange={event => setCourse({ ...course, name: event.target.value })} placeholder="例如：高等数学" required /></label><label>地点<input value={course.place} onChange={event => setCourse({ ...course, place: event.target.value })} placeholder="教室（可选）" /></label><label>星期<select value={course.day} onChange={event => setCourse({ ...course, day: Number(event.target.value) })}>{weekDays.map((day, index) => <option key={day} value={index}>{day}</option>)}</select></label><label>开始节次<input type="number" min="1" max="12" value={course.start} onChange={event => setCourse({ ...course, start: Number(event.target.value) })} /></label><label>结束节次<input type="number" min={course.start} max="12" value={course.end} onChange={event => setCourse({ ...course, end: Number(event.target.value) })} /></label></div><button type="submit"><Plus size={15} /> 添加到课表</button></form>
      {data.courses.length ? <div className="campus-course-list">{data.courses.map(item => <div key={item.id}><span><strong>{item.name}</strong><small>{weekDays[item.day]} · {item.start}–{item.end} 节 · {item.place || '未填写教室'}</small></span><button type="button" aria-label={`删除课程 ${item.name}`} onClick={() => setData(current => ({ ...current, courses: current.courses.filter(courseItem => courseItem.id !== item.id) }))}><Trash2 size={15} /></button></div>)}</div> : null}
      <p className="campus-footnote">{liveClasses ? teachingWeek === null ? '教学周次未确认，暂时展示全部教务课程；手动课表仍每周重复。' : '教务课程按已提供的教学周展示；缺少周次的安排暂时每周显示，手动课表每周重复。' : '手动课表按每周重复显示；绑定账号后可同步教务数据。'}{!campusSession ? <button type="button" className="campus-inline-action" onClick={() => setCredentialDialogOpen(true)}>同步校园账号</button> : !officeConnected ? <button type="button" className="campus-inline-action" onClick={() => { setOfficeDialogOpen(true); void loadOfficeCaptcha(); }}>连接办公网</button> : <button type="button" className="campus-inline-action" onClick={() => void loadAcademicData()} disabled={academicLoading}>{academicLoading ? '正在同步教务数据…' : '刷新教务数据'}</button>}</p>
      {liveExams.length ? <section className="campus-exam-list"><h2>近期考试</h2>{liveExams.map((exam, index) => <div key={String(exam.id ?? index)}><strong>{firstText(exam, ['name', 'course_name', 'courseName', 'course']) || '未命名考试'}</strong><span>{[firstText(exam, ['date', 'exam_date', 'examDate']), firstText(exam, ['time', 'exam_time', 'examTime']), firstText(exam, ['location', 'place', 'room'])].filter(Boolean).join(' · ') || '考试安排待补充'}</span></div>)}</section> : null}
    </> : null}
    {activeId === 'entry' ? <div className="campus-entry-message"><QrCode size={33} /><div><h2>入校码需要实时认证</h2><p>微北洋实时入校码由校园 CAS 签发，有效期约 3 分钟，不会写入本地存储。</p>{entryCode ? <div className="campus-entry-code">{/^data:image|^https?:\/\//.test(entryCode.content) ? <img src={entryCode.content} alt="实时入校码" /> : <code>{entryCode.content}</code>}<small>有效至 {new Date(entryCode.expires_at).toLocaleTimeString('zh-CN')}</small></div> : null}<button type="button" className="campus-action-button" onClick={() => campusSession ? void refreshEntryCode() : setCredentialDialogOpen(true)}><QrCode size={15} /> {entryCode ? '刷新入校码' : campusSession ? '获取入校码' : '绑定账号后获取'}</button></div></div> : null}
    {activeId === 'map' ? <><div className="campus-map-index"><div><img src="/campus/map/wjl-thumb.jpeg" alt="卫津路校区地图" /><Map size={27} /><h2>卫津路校区</h2><p>南开区卫津路 92 号</p><a className="campus-external" href="/campus/map/wjl.png" target="_blank" rel="noopener noreferrer">查看高清地图<ExternalLink size={15} /></a></div><div><img src="/campus/map/byy-thumb.jpeg" alt="北洋园校区地图" /><School size={27} /><h2>北洋园校区</h2><p>津南区雅观路 135 号</p><a className="campus-external" href="/campus/map/byy.png" target="_blank" rel="noopener noreferrer">查看高清地图<ExternalLink size={15} /></a></div></div><p className="campus-footnote">地图资源随微北洋客户端分发；校内道路和楼宇如有调整，以学校公告为准。</p></> : null}
    {activeId === 'calendar' ? <div className="campus-calendar-sheet"><CalendarDays size={27} /><h2>学校校历</h2><p>显示微北洋随包发布的校历资料。教学安排调整时，请以天津大学教务处正式通知为准。</p><div className="campus-calendar-images"><a href="/campus/calendar/first.jpg" target="_blank" rel="noopener noreferrer"><img src="/campus/calendar/first-thumb.jpg" alt="学校校历上半页" /></a><a href="/campus/calendar/second.jpg" target="_blank" rel="noopener noreferrer"><img src="/campus/calendar/second-thumb.jpg" alt="学校校历下半页" /></a></div><External href="https://oaa.tju.edu.cn/">打开天津大学教务处</External></div> : null}
    {activeId === 'gpa' ? <>
      <div className="campus-gpa-result"><span>{schoolGrades.length ? '办公网教务 GPA' : '本地学分加权平均绩点'}</span><strong>{totalCredits ? average.toFixed(3) : '—'}</strong><small>{totalCredits ? `${totalCredits.toFixed(1)} 学分 · ${visibleGrades.length} 门课程` : '添加课程或绑定账号后开始计算'}</small></div>
      <p className="campus-footnote">{schoolGrades.length ? '数据来自办公网教务接口。' : '本地估算：Σ(课程绩点 × 学分) ÷ Σ学分。'}{!campusSession ? <button type="button" className="campus-inline-action" onClick={() => setCredentialDialogOpen(true)}>同步校园账号</button> : !officeConnected ? <button type="button" className="campus-inline-action" onClick={() => { setOfficeDialogOpen(true); void loadOfficeCaptcha(); }}>连接办公网</button> : <button type="button" className="campus-inline-action" onClick={() => void loadAcademicData()} disabled={academicLoading}>{academicLoading ? '正在同步教务数据…' : '刷新教务数据'}</button>}</p>
      <form className="campus-form campus-inline-form" onSubmit={addGrade}><h2>录入课程绩点</h2><div className="campus-form-grid"><label>课程名<input value={grade.name} onChange={event => setGrade({ ...grade, name: event.target.value })} placeholder="课程名" required /></label><label>学分<input type="number" min=".1" step=".1" value={grade.credits} onChange={event => setGrade({ ...grade, credits: event.target.value })} required /></label><label>绩点（0–4）<input type="number" min="0" max="4" step=".01" value={grade.points} onChange={event => setGrade({ ...grade, points: event.target.value })} required /></label></div><button type="submit"><Plus size={15} /> 计入平均</button></form>
      <div className="campus-grade-list">{data.grades.map(item => <div key={item.id}><span>{item.name}</span><span>{item.credits} 学分</span><strong>{item.points.toFixed(2)}</strong><button type="button" aria-label={`删除成绩 ${item.name}`} onClick={() => setData(current => ({ ...current, grades: current.grades.filter(gradeItem => gradeItem.id !== item.id) }))}><Trash2 size={15} /></button></div>)}</div>
    </> : null}
    {activeId === 'rooms' ? <div className="campus-service-sheet">
      <Clock3 size={28} /><h2>微北洋空教室</h2><p>选择日期和节次，查询教室空闲情况。点击教室可查看时间表。</p>
      {campusSession ? <>
        <div className="campus-room-filters">
          <label>日期<input type="date" value={roomDate} onChange={event => { setRoomDate(event.target.value); if (selectedBuilding !== null) void loadRooms(selectedBuilding, event.target.value, roomSession); }} /></label>
          <label>节次<select value={roomSession} onChange={event => { const session = Number(event.target.value); setRoomSession(session); if (selectedBuilding !== null) void loadRooms(selectedBuilding, roomDate, session); }}>{Array.from({ length: 12 }, (_, index) => <option value={index + 1} key={index + 1}>第 {index + 1} 节</option>)}</select></label>
        </div>
        <div className="campus-live-actions">
          <button type="button" className="campus-action-button" onClick={() => void loadCampuses()}>读取校区</button>
          {rooms.campuses.map(item => <button type="button" className="campus-choice-button" aria-pressed={selectedCampus === item.id} key={String(item.id)} onClick={() => item.id !== undefined && void loadBuildings(item.id)}>{String(item.name || item.id)}</button>)}
        </div>
        {selectedCampus !== null ? <div className="campus-live-actions">
          {rooms.buildings.map(item => <button type="button" className="campus-choice-button" aria-pressed={selectedBuilding === item.id} key={String(item.id)} onClick={() => item.id !== undefined && void loadRooms(item.id)}>{String(item.name || item.id)}</button>)}
        </div> : null}
        {selectedBuilding !== null ? <>
          {roomLoading ? <p role="status">正在查询教室空闲状态…</p> : !roomDate ? <p role="status">请选择日期后查询教室。</p> : rooms.rooms.length ? <div className="campus-room-list">
            {rooms.rooms.map(item => <button type="button" className="campus-room-row" aria-pressed={selectedRoom === item.id} key={String(item.id)} onClick={() => item.id !== undefined && void loadRoomSchedule(item.id)}><strong>{String(item.name || item.id)}</strong><span>{typeof item.free === 'boolean' ? item.free ? '空闲' : '使用中' : '状态未知'}</span></button>)}
          </div> : !liveError ? <p role="status">所选日期和节次没有教室数据。</p> : null}
        </> : null}
        {selectedRoom !== null ? <section className="campus-room-schedule" aria-label="教室时间表">
          <h3>{rooms.rooms.find(item => item.id === selectedRoom)?.name || '教室'} · 时间表</h3>
          {scheduleState === 'loading' ? <p role="status">正在读取时间表…</p> : null}
          {scheduleState === 'ready' && !roomSchedule.length ? <p role="status">暂无时间表记录。</p> : null}
          {scheduleState === 'ready' && roomSchedule.length ? <div className="campus-room-schedule-list">{roomSchedule.map((row, index) => {
            const details = roomScheduleDetails(row);
            return <div key={String(row.id ?? index)}><strong>{firstText(row, ['name', 'title', 'course_name', 'courseName']) || `安排 ${index + 1}`}</strong><span>{details.length ? details.join(' · ') : '未提供可识别的时间和状态'}</span></div>;
          })}</div> : null}
        </section> : null}
      </> : <><p className="campus-footnote">空教室需要实时校园数据。</p><button type="button" className="campus-action-button" onClick={() => setCredentialDialogOpen(true)}>绑定账号后读取</button></>}
    </div> : null}
    {activeId === 'forum' ? <div className="campus-forum-sheet">
      <MessageSquareText size={28} /><h2>青年湖底</h2><p>帖子来自微北洋论坛实时接口。这里只提供只读列表。</p>
      {campusSession ? <button type="button" className="campus-action-button" onClick={() => void loadForum(forum?.page ?? 1)} disabled={forumLoading}>{forumLoading ? '正在读取…' : forum ? '刷新帖子' : '读取帖子'}</button> : <><p className="campus-footnote">论坛需要连接微北洋账号。</p><button type="button" className="campus-action-button" onClick={() => setCredentialDialogOpen(true)}>绑定账号后查看</button></>}
      {forum ? <>
        <div className="campus-forum-heading"><strong>最新帖子</strong><span>第 {forum.page} 页 · 共 {forum.posts.total} 条</span></div>
        {forum.posts.list.length ? <ul className="campus-forum-list">{forum.posts.list.map(post => <li key={post.id}>
          <strong>{post.title.trim() || `青年湖底帖子 #${post.id}`}</strong>
          <div className="campus-forum-meta">
            {post.tag?.name ? <span>{post.tag.name}</span> : null}
            <time>{post.created_at.slice(0, 16).replace('T', ' ')}</time>
            {post.comment_count !== undefined ? <span>回复 {post.comment_count}</span> : null}
            {post.like_count !== undefined ? <span>赞 {post.like_count}</span> : null}
          </div>
        </li>)}</ul> : <p role="status">这一页暂无帖子。</p>}
        <nav className="campus-forum-pages" aria-label="论坛分页">
          <button type="button" disabled={forumLoading || forum.page === 1} onClick={() => void loadForum(forum.page - 1)}><ChevronLeft size={15} /> 上一页</button>
          <button type="button" disabled={forumLoading || forum.page * forumPageSize >= forum.posts.total || !forum.posts.list.length} onClick={() => void loadForum(forum.page + 1)}>下一页 <ChevronRight size={15} /></button>
        </nav>
      </> : forumLoading ? <p role="status">正在读取论坛帖子…</p> : null}
    </div> : null}
    {activeId === 'focus' ? <div className="campus-focus"><div className="campus-focus-clock" role="timer" aria-label={`剩余 ${focusLabel}`}><span>{focusLabel}</span><small>{focus.endsAt ? '专注中' : remaining === 0 ? '完成一次专注' : '准备开始'}</small></div><div className="campus-focus-actions"><button type="button" onClick={() => { setNow(Date.now()); setFocus(current => current.endsAt ? { ...current, endsAt: null, remaining: Math.max(0, Math.ceil((current.endsAt - Date.now()) / 1000)) } : { ...current, endsAt: Date.now() + current.remaining * 1000 }); }} disabled={remaining === 0}>{focus.endsAt ? <Pause size={16} /> : <Play size={16} />}{focus.endsAt ? '暂停' : '开始专注'}</button><button type="button" onClick={() => setFocus(current => ({ ...current, endsAt: null, remaining: current.duration * 60 }))}><RotateCcw size={16} /> 重置</button></div><div className="campus-focus-presets" aria-label="专注时长">{[15, 25, 45, 60].map(minutes => <button type="button" key={minutes} aria-pressed={focus.duration === minutes} onClick={() => setFocus(current => ({ ...current, duration: minutes, remaining: minutes * 60, endsAt: null }))}>{focus.duration === minutes ? <Check size={14} /> : null}{minutes} 分钟</button>)}</div><p><strong>{focus.sessions}</strong> 次专注已完成 · 按实际时间计算，切换工具或锁屏后仍可恢复。</p></div> : null}
    {needsCampusBinding ? <CredentialVault identity={identity} open={credentialDialogOpen} onOpenChange={setCredentialDialogOpen} onUnlock={unlockLiveCampus} onLock={lockLiveCampus} /> : null}
    <Dialog open={officeDialogOpen} onOpenChange={setOfficeDialogOpen}>
      <DialogContent className="campus-credential-dialog">
        <header className="campus-dialog-header"><div><DialogTitle>连接办公网教务</DialogTitle><DialogDescription>查看下方验证码图片，完成办公网认证后同步课表、考试和 GPA。微北洋连接独立保留。</DialogDescription></div><DialogClose asChild><button type="button" className="campus-dialog-close" aria-label="关闭办公网认证"><X size={17} /></button></DialogClose></header>
        <form className="campus-dialog-body campus-office-form" onSubmit={submitOfficeCode}>
          {officeCaptcha ? <img className="campus-office-captcha" src={`data:${officeCaptcha.content_type};base64,${officeCaptcha.data}`} alt="办公网验证码" /> : null}
          {officeError ? <p className="campus-live-error" role="alert">{officeError}</p> : null}
          <label>图片验证码<input autoComplete="off" value={officeCode} onChange={event => setOfficeCode(event.target.value)} disabled={!officeCaptcha || officeBusy} required /></label>
          <div className="campus-form-actions"><button type="submit" disabled={!officeCaptcha || !officeCode.trim() || officeBusy}>连接办公网</button><button type="button" onClick={() => void loadOfficeCaptcha()} disabled={officeBusy}>刷新图片</button><button type="button" onClick={() => setOfficeDialogOpen(false)}>稍后再说</button></div>
        </form>
      </DialogContent>
    </Dialog>
  </section>;
}
